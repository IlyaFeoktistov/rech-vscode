// Расширение VS Code для языка Rech (github.com/IlyaFeoktistov/Rech).
// Автор: Ilya Feoktistov.
//
// Команды "Rech: собрать"/"Rech: собрать библиотеку"/"Rech: собрать и
// запустить"/"Rech: отладить" (через child_process, не интерактивный
// терминал - вывод разбирается на диагностику "строка N"), "Rech: запустить
// тесты" (по каталогу проекта, через rech test). "Rech: собрать библиотеку" -
// тот же "rech build", только с "--lib" (docs/ROADMAP.md, Шаг 7,
// "обратное направление") - собирает разделяемую библиотеку (.so/.dylib/
// .dll) и C-заголовок (.h) вместо обычного бинарника; своей команды
// запуска для библиотеки нет - "rech run --lib" сам по себе ошибка
// (библиотека не исполняется как программа). "rech.run" запускается в
// интегрированном терминале,
// а не через child_process - в отличие от build/test, у выполняемой
// Rech-программы может быть собственный интерактивный ввод
// (прочитать_строку и т. п.), терминал даёт ей настоящий stdin.
//
// Цель ("что собрать/запустить/отладить") - файл проекта (*.rechproj) в
// корне рабочей области, если он там ровно один (то же самое, что "rech
// build"/"rech run" сами делают без явного пути - internal/project.Find);
// иначе - активный .rech-файл редактора (resolveTarget). Отладчик (DAP,
// docs/ROADMAP.md, шаг 19) реализован целиком в самом компиляторе ("rech
// debug" - сервер протокола по stdin/stdout, internal/debugadapter) - это
// расширение только запускает его как внешний процесс и передаёт цель через
// launch.program, никакой логики отладки здесь нет.
//
// Hover/автодополнение - тем же принципом, реализованы в "rech lsp"
// (сервер LSP по stdin/stdout, internal/lsp) - это расширение запускает
// его один раз (лениво, при первом обращении) и говорит с ним напрямую по
// JSON-RPC 2.0 (LspClient ниже), без пакета vscode-languageclient (никакого
// npm-зависимого шага сборки в этом расширении, тот же принцип, что и у
// остальной части файла).

const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

let diagnostics;
let outputChannel;
let terminal;
let lspClient;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('rech');
  outputChannel = vscode.window.createOutputChannel('Rech');
  lspClient = new LspClient();
  context.subscriptions.push(diagnostics, outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('rech.build', () => runCaptured('build')),
    vscode.commands.registerCommand('rech.buildLib', () => runCaptured('build', { extraArgs: ['--lib'] })),
    vscode.commands.registerCommand('rech.run', () => runInTerminal('run')),
    vscode.commands.registerCommand('rech.test', () => runCaptured('test', { wholeProject: true })),
    vscode.commands.registerCommand('rech.debug', () => startDebugging()),
    vscode.debug.registerDebugConfigurationProvider('rech', new RechDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory('rech', new RechDebugAdapterDescriptorFactory()),
    vscode.languages.registerHoverProvider('rech', { provideHover: provideRechHover }),
    vscode.languages.registerDefinitionProvider('rech', { provideDefinition: provideRechDefinition }),
    vscode.languages.registerCompletionItemProvider('rech', { provideCompletionItems: provideRechCompletionItems }, '.')
  );
}

function deactivate() {
  if (terminal) {
    terminal.dispose();
  }
  if (lspClient) {
    lspClient.stop();
  }
}

function rechPath() {
  return vscode.workspace.getConfiguration('rech').get('path') || 'rech';
}

// saveIfRechEditor сохраняет активный редактор, если это .rech-файл -
// компилятор видит только то, что уже записано на диск, без этого
// "собрать"/"отладить" смотрели бы на устаревшую версию файла. Не ошибка,
// если активный редактор - не .rech (например, открыт файл проекта) -
// нечего сохранять, это не то же самое, что "нет цели вообще" (см.
// resolveTarget).
async function saveIfRechEditor() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'rech') {
    await editor.document.save();
  }
}

// resolveTarget - см. package doc про выбор между файлом проекта и активным
// файлом. target - то, что передаётся "rech <команда>"/launch.program;
// diagUri - куда ставить диагностику разбора ошибок (null, если цель -
// файл проекта, а не конкретный открытый .rech-файл - диагностика тогда
// ставится на активный редактор, если он .rech, см. runCaptured).
async function resolveTarget() {
  await saveIfRechEditor();

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder) {
    const projFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.rechproj'), null, 2);
    if (projFiles.length === 1) {
      return { target: projFiles[0].fsPath, cwd: folder.uri.fsPath };
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rech') {
    vscode.window.showErrorMessage('Rech: нет файла проекта (.rechproj) в рабочей области и нет открытого .rech-файла в активном редакторе.');
    return null;
  }
  return { target: editor.document.fileName, cwd: path.dirname(editor.document.fileName) };
}

// diagnosticTarget - файл, на который имеет смысл ставить диагностику
// разбора ошибок компилятора (только реальный .rech-файл - у .rechproj
// свой собственный текст, диагностика по "строка N" его текста была бы
// бессмысленна на файле проекта).
function diagnosticTarget() {
  const editor = vscode.window.activeTextEditor;
  return editor && editor.document.languageId === 'rech' ? editor.document.uri : null;
}

async function runInTerminal(subcommand) {
  const resolved = await resolveTarget();
  if (!resolved) {
    return;
  }
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal('Rech');
  }
  terminal.show(true);
  terminal.sendText(`${quoteArg(rechPath())} ${subcommand} ${quoteArg(resolved.target)}`);
}

// runCaptured запускает "rech <subcommand>" через child_process (не
// терминал) - вывод не для интерактивного ввода, а для разбора: строки
// stderr вида "строка N[, столбец M]: ..." становятся диагностикой в
// редакторе на этой строке, весь вывод целиком - в OutputChannel.
// wholeProject - для "rech test" запускает по корню открытой рабочей
// области, а не по одному файлу (тесты обычно разбросаны по каталогу).
// extraArgs - флаги между subcommand и target ("--lib" у "Rech: собрать
// библиотеку") - execRech всё равно берёт cwd из ПОСЛЕДНЕГО элемента
// массива аргументов, значит extraArgs должны идти перед target, не после.
async function runCaptured(subcommand, opts = {}) {
  let target;
  if (opts.wholeProject) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) {
      vscode.window.showErrorMessage('Rech: нет открытой рабочей области для "rech test".');
      return;
    }
    await saveIfRechEditor();
    target = folder.uri.fsPath;
  } else {
    const resolved = await resolveTarget();
    if (!resolved) {
      return;
    }
    target = resolved.target;
  }

  const extraArgs = opts.extraArgs || [];

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`$ ${rechPath()} ${subcommand} ${extraArgs.join(' ')} ${target}`.replace(/ {2,}/g, ' '));

  const result = await execRech([subcommand, ...extraArgs, target]);
  outputChannel.append(result.stdout);
  outputChannel.append(result.stderr);

  const diagFile = diagnosticTarget();
  if (diagFile) {
    diagnostics.set(diagFile, parseDiagnostics(result.stderr));
  }

  if (result.code === 0) {
    outputChannel.appendLine(`\n[готово, код выхода 0]`);
  } else {
    outputChannel.appendLine(`\n[завершилось с кодом ${result.code}]`);
  }
}

function execRech(args) {
  return new Promise((resolve) => {
    const proc = cp.spawn(rechPath(), args, { cwd: path.dirname(args[args.length - 1]) });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      resolve({ stdout, stderr: stderr + `\nне удалось запустить "${rechPath()}": ${err.message}\n`, code: -1 });
    });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

// parseDiagnostics - разбор "строка N[, столбец M]: ..." из текста ошибки
// компилятора (internal/parser, internal/semantic, internal/backend/
// cbackend - все три пишут в этом формате, см. docs/SPEC.md). Лучший
// эффорт: если ошибка на самом деле в другом файле (например, в файле,
// импортированном через "использовать") - диагностика всё равно ставится
// на текущий файл, потому что сам текст ошибки не всегда содержит имя
// файла в разбираемом месте. Столбец по умолчанию - начало строки, если в
// тексте ошибки его нет.
function parseDiagnostics(stderrText) {
  const out = [];
  const re = /строка (\d+)(?:, столбец (\d+))?: ([^\n]+)/g;
  let m;
  while ((m = re.exec(stderrText)) !== null) {
    const line = Math.max(0, parseInt(m[1], 10) - 1);
    const col = m[2] ? Math.max(0, parseInt(m[2], 10) - 1) : 0;
    const range = new vscode.Range(line, col, line, col + 1);
    out.push(new vscode.Diagnostic(range, m[3], vscode.DiagnosticSeverity.Error));
  }
  return out;
}

function quoteArg(s) {
  if (process.platform === 'win32') {
    return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  return /[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

// startDebugging - команда "Rech: отладить" (кнопка/палитра команд, без
// нужды в собственном launch.json) - та же цель, что и у build/run
// (resolveTarget), запускается сразу, без диалога конфигурации.
async function startDebugging() {
  const resolved = await resolveTarget();
  if (!resolved) {
    return;
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  await vscode.debug.startDebugging(folder, {
    type: 'rech',
    request: 'launch',
    name: 'Rech: отладить',
    program: resolved.target,
  });
}

// RechDebugConfigurationProvider подставляет program (см. resolveTarget),
// если конфигурация запуска (в т. ч. синтезированная F5 без единого
// launch.json в проекте) его не задаёт явно - launch.json пользователя,
// указавший program сам, имеет приоритет, ничего не переопределяется.
class RechDebugConfigurationProvider {
  async resolveDebugConfiguration(_folder, config) {
    if (!config.type && !config.request && !config.name) {
      config.type = 'rech';
      config.request = 'launch';
      config.name = 'Rech: отладить';
    }
    if (!config.program) {
      const resolved = await resolveTarget();
      if (!resolved) {
        return undefined; // resolveTarget уже показал сообщение об ошибке
      }
      config.program = resolved.target;
    }
    return config;
  }
}

// RechDebugAdapterDescriptorFactory - весь отладчик реализован в "rech
// debug" (сервер DAP по stdin/stdout, internal/debugadapter) - расширение
// только запускает этот процесс, никакого встроенного в JS адаптера нет.
class RechDebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor() {
    return new vscode.DebugAdapterExecutable(rechPath(), ['debug']);
  }
}

// LspClient - клиент JSON-RPC 2.0 к "rech lsp" (internal/lsp) поверх
// Content-Length-кадра (тот же формат, что и у DAP-стороны выше, но здесь
// он разобран вручную - ни один пакет вроде vscode-languageclient не
// подключается, см. package doc). Один процесс на всё время жизни
// расширения (не пересоздаётся на каждый файл) - запускается лениво, при
// первом hover/completion.
class LspClient {
  constructor() {
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.knownDocs = new Set();
  }

  ensureStarted() {
    if (this.proc) {
      return;
    }
    this.proc = cp.spawn(rechPath(), ['lsp']);
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.on('error', () => { this.proc = null; });
    this.proc.on('exit', () => { this.proc = null; this.knownDocs.clear(); });
    this.request('initialize', {});
  }

  stop() {
    if (this.proc) {
      this.notify('exit', null);
      this.proc = null;
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    }
  }

  send(msg) {
    if (!this.proc) {
      return;
    }
    const b = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${b.length}\r\n\r\n`);
    this.proc.stdin.write(b);
  }

  request(method, params) {
    this.ensureStarted();
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // syncDocument сообщает серверу текущее содержимое document целиком
  // (didOpen при первом обращении к этому URI, иначе didChange -
  // textDocumentSync: Full на стороне сервера ожидает именно весь текст, не
  // дифф) - вызывается перед КАЖДЫМ hover/completion, чтобы сервер всегда
  // видел то же, что сейчас в редакторе, даже без отдельных подписок на
  // onDidChangeTextDocument.
  syncDocument(document) {
    this.ensureStarted();
    const uri = document.uri.toString();
    const text = document.getText();
    if (this.knownDocs.has(uri)) {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: document.version },
        contentChanges: [{ text }],
      });
    } else {
      this.knownDocs.add(uri);
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'rech', version: document.version, text },
      });
    }
  }
}

async function provideRechHover(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/hover', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !resp.result || !resp.result.contents) {
    return null;
  }
  return new vscode.Hover(new vscode.MarkdownString(resp.result.contents.value));
}

async function provideRechDefinition(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/definition', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !resp.result) {
    return null;
  }
  const { uri, range } = resp.result;
  return new vscode.Location(
    vscode.Uri.parse(uri),
    new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
  );
}

// completionKindMap - LSP CompletionItemKind (1-индексный, см.
// internal/lsp/completion.go) -> vscode.CompletionItemKind (0-индексный) -
// числа НЕ совпадают между двумя перечислениями, нужен явный перевод.
const completionKindMap = {
  2: vscode.CompletionItemKind.Method,
  3: vscode.CompletionItemKind.Function,
  5: vscode.CompletionItemKind.Field,
  6: vscode.CompletionItemKind.Variable,
  7: vscode.CompletionItemKind.Class,
  14: vscode.CompletionItemKind.Keyword,
};

async function provideRechCompletionItems(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/completion', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map((item) => {
    const ci = new vscode.CompletionItem(item.label, completionKindMap[item.kind]);
    if (item.detail) {
      ci.detail = item.detail;
    }
    if (item.documentation) {
      ci.documentation = new vscode.MarkdownString(item.documentation);
    }
    return ci;
  });
}

module.exports = { activate, deactivate };
