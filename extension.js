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
const fs = require('fs');
const os = require('os');

let diagnostics;
let lspDiagnostics;
let outputChannel;
let terminal;
let lspClient;

// lspSeverityMap - LSP DiagnosticSeverity (1-индексный, см. LSP spec и
// internal/lsp/diagnostics.go/deprecated.go) -> vscode.DiagnosticSeverity
// (0-индексный) - числа НЕ совпадают между двумя перечислениями, нужен
// явный перевод (тот же принцип, что и у completionKindMap ниже).
const lspSeverityMap = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
};

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('rech');
  outputChannel = vscode.window.createOutputChannel('Rech');
  lspClient = new LspClient();

  context.subscriptions.push(
    diagnostics, outputChannel,
    vscode.commands.registerCommand('rech.build', () => runCaptured('build')),
    vscode.commands.registerCommand('rech.buildLib', () => runCaptured('build', { extraArgs: ['--lib'] })),
    vscode.commands.registerCommand('rech.run', () => runInTerminal('run')),
    vscode.commands.registerCommand('rech.test', () => runCaptured('test', { wholeProject: true })),
    vscode.commands.registerCommand('rech.runTestFile', (filePath) => runCaptured('test', { explicitTarget: filePath })),
    vscode.commands.registerCommand('rech.debug', () => startDebugging()),
    vscode.debug.registerDebugConfigurationProvider('rech', new RechDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory('rech', new RechDebugAdapterDescriptorFactory()),
    vscode.languages.registerDocumentFormattingEditProvider('rech', { provideDocumentFormattingEdits: provideRechDocumentFormattingEdits })
  );

  // rech.lsp.enable - читается ОДИН РАЗ, при activate (не подписка на
  // onDidChangeConfiguration) - смена значения требует "Reload Window", как
  // и описано в самой настройке (package.json): отписать уже
  // зарегистрированные провайдеры/остановить процесс "rech lsp" на лету
  // не стоит усложнения ради экономии одной перезагрузки окна.
  if (!vscode.workspace.getConfiguration('rech').get('lsp.enable', true)) {
    return;
  }

  // lspDiagnostics - ОТДЕЛЬНАЯ коллекция от diagnostics (та заполняется
  // разбором вывода "Rech: собрать"/"rech.build", см. runCaptured/
  // parseDiagnostics) - у LSP-диагностики (publishDiagnostics, живая, на
  // каждое открытие/изменение файла) свой жизненный цикл, не связанный с
  // ручным запуском сборки; общая коллекция перепутала бы источники (пустой
  // список от LSP после успешного анализа стёр бы диагностику от build, и
  // наоборот).
  lspDiagnostics = vscode.languages.createDiagnosticCollection('rech-lsp');
  lspClient.onNotification('textDocument/publishDiagnostics', (params) => {
    const uri = vscode.Uri.parse(params.uri);
    const diags = (params.diagnostics || []).map((d) => {
      const diag = new vscode.Diagnostic(
        new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character),
        d.message,
        lspSeverityMap[d.severity] ?? vscode.DiagnosticSeverity.Warning
      );
      // LSP DiagnosticTag (1 - Unnecessary, 2 - Deprecated, см. internal/
      // lsp/deprecated.go) - те же числа, что и vscode.DiagnosticTag, можно
      // передать как есть, без перевода.
      if (Array.isArray(d.tags) && d.tags.length > 0) {
        diag.tags = d.tags;
      }
      return diag;
    });
    lspDiagnostics.set(uri, diags);
  });
  context.subscriptions.push(lspDiagnostics);

  // Синхронизация документа с LSP-сервером ПРОАКТИВНО (не только лениво,
  // перед hover/definition/completion, см. syncDocument) - только так
  // диагностика (подчёркивание ошибки) обновляется по мере набора текста,
  // а не только в момент, когда пользователь что-то дополнительно
  // запросил (навёл мышь/нажал Ctrl). Фильтр по languageId - не гонять
  // сервер на файлах других языков, открытых в той же рабочей области.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'rech') {
      lspClient.syncDocument(doc);
    }
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'rech') {
        lspClient.syncDocument(doc);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'rech') {
        lspClient.syncDocument(e.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('rech', { provideHover: provideRechHover }),
    vscode.languages.registerDefinitionProvider('rech', { provideDefinition: provideRechDefinition }),
    vscode.languages.registerImplementationProvider('rech', { provideImplementation: provideRechImplementation }),
    vscode.languages.registerReferenceProvider('rech', { provideReferences: provideRechReferences }),
    vscode.languages.registerDocumentHighlightProvider('rech', { provideDocumentHighlights: provideRechDocumentHighlights }),
    vscode.languages.registerCodeActionsProvider('rech', { provideCodeActions: provideRechCodeActions }, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerCompletionItemProvider('rech', { provideCompletionItems: provideRechCompletionItems }, '.', '"'),
    vscode.languages.registerCodeLensProvider('rech', { provideCodeLenses: provideRechCodeLenses }),
    vscode.languages.registerSignatureHelpProvider('rech', { provideSignatureHelp: provideRechSignatureHelp }, '(', ','),
    // "Перейти к определению" на встроенной функции (internal/lsp/
    // builtindefinition.go) ведёт на синтетический URI "rech-builtin:///
    // <имя>.rech" - без своего content-провайдера VS Code просто не смог бы
    // открыть такой документ вовсе ("Unable to open ..."). Сам текст -
    // отдельным запросом "rech/builtinSource" (обычный "textDocument/
    // definition" несёт только Location, не содержимое файла).
    vscode.workspace.registerTextDocumentContentProvider('rech-builtin', {
      provideTextDocumentContent: provideRechBuiltinSource,
    }),
    // Семантическая подсветка (internal/lsp/semantictokens.go) - вид имени
    // по РЕАЛЬНОМУ объявлению (функция/тип/переменная/...), не по регистру
    // первой буквы, как статическая TextMate-грамматика (syntaxes/
    // rech.tmLanguage.json) - там, где сервер что-то вернул, VS Code сам
    // отдаёт этому приоритет перед TextMate, иначе (документ с ошибкой
    // разбора и т. п.) подсветка остаётся прежней.
    vscode.languages.registerDocumentSemanticTokensProvider(
      'rech',
      { provideDocumentSemanticTokens: provideRechDocumentSemanticTokens },
      rechSemanticTokensLegend
    )
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

// traceLspMessage - "rech.lsp.trace.server" (тот же принцип именования,
// что и стандартная "<язык>.trace.server" у расширений на базе
// vscode-languageclient, package.json) - "off" молчит совсем, "messages"
// печатает только метод/id (без параметров/результата - которые могут
// быть большими и малополезными без "verbose"), "verbose" - всё сообщение
// целиком. direction - "->" (клиент шлёт серверу) или "<-" (ответ/
// уведомление сервера).
function traceLspMessage(direction, msg) {
  const level = vscode.workspace.getConfiguration('rech').get('lsp.trace.server', 'off');
  if (level === 'off' || !outputChannel) {
    return;
  }
  if (level === 'verbose') {
    outputChannel.appendLine(`[LSP ${direction}] ${JSON.stringify(msg)}`);
    return;
  }
  const label = msg.method ? msg.method : `ответ #${msg.id}`;
  outputChannel.appendLine(`[LSP ${direction}] ${label}${msg.id !== undefined && msg.method ? ` (#${msg.id})` : ''}`);
}

// provideRechDocumentFormattingEdits - "rech fmt <файл>" (docs/ROADMAP.md,
// Шаг 89 - канонический отступ, как gofmt) без "--write" - вывод в stdout,
// вставляется ОДНИМ TextEdit на весь документ (сам компилятор форматирует
// целый файл, не диапазон - частичное форматирование выделения не
// поддержано никак). Работает через "editor.formatOnSave" (штатная
// настройка VS Code, не своя - расширение только регистрирует провайдер) и
// команду "Format Document" - обе включаются/выключаются настройкой
// "rech.format.enable" здесь, а не отменой самой регистрации провайдера
// (иначе смена настройки потребовала бы перезапуска окна). Компилятор читает
// файл С ДИСКА (не stdin) - но НЕ через document.save() (как было раньше):
// вызов save() ИЗНУТРИ этого же провайдера, пока VS Code вызывает его
// именно ПОТОМУ, что идёт сохранение ("editor.formatOnSave") - повторный
// вход в тот же пайплайн сохранения, из-за которого правки как будто
// откатывались назад при каждом Ctrl+S (репортнуто пользователем - "как
// будто работает не Ctrl+S, а Ctrl+Z", воспроизводилось только на
// .rech-файлах). Вместо этого - живой текст буфера (document.getText(),
// а не то, что уже на диске) пишется во ВРЕМЕННЫЙ файл, форматируется ОН,
// реальный файл документа этой функцией не трогается вовсе - сохраняет
// его дальше сам VS Code, как обычно, ровно один раз.
async function provideRechDocumentFormattingEdits(document) {
  if (!vscode.workspace.getConfiguration('rech').get('format.enable', true)) {
    return [];
  }
  const tmpFile = path.join(os.tmpdir(), `rech-fmt-${process.pid}-${Date.now()}.rech`);
  let result;
  try {
    fs.writeFileSync(tmpFile, document.getText(), 'utf8');
    result = await execRech(['fmt', tmpFile]);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
  if (result.code !== 0) {
    outputChannel.appendLine(`$ ${rechPath()} fmt ${document.fileName}`);
    outputChannel.append(result.stderr);
    return [];
  }
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  return [vscode.TextEdit.replace(fullRange, result.stdout)];
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
// explicitTarget - готовый путь файла (CodeLens "▶ запустить тест",
// codelens.go/runTestCodeLens - его аргумент, путь ЭТОГО конкретного
// тестового файла) - в отличие от wholeProject/обычной ветки ниже, не
// зависит от рабочей области или активного редактора вовсе. extraArgs -
// флаги между subcommand и target ("--lib" у "Rech: собрать библиотеку") -
// execRech всё равно берёт cwd из ПОСЛЕДНЕГО элемента массива аргументов,
// значит extraArgs должны идти перед target, не после.
async function runCaptured(subcommand, opts = {}) {
  let target;
  if (opts.explicitTarget) {
    target = opts.explicitTarget;
  } else if (opts.wholeProject) {
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
    this.notificationHandlers = new Map();
  }

  // onNotification регистрирует обработчик уведомления сервер->клиент
  // (сообщение без "id" - см. onData) - используется для
  // "textDocument/publishDiagnostics" (диагностика, activate ниже), не
  // задействуется для запрос/ответ (hover/definition/completion/
  // implementation - те решаются через this.pending, по "id").
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
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
      traceLspMessage('<-', msg);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.id === undefined && msg.method && this.notificationHandlers.has(msg.method)) {
        this.notificationHandlers.get(msg.method)(msg.params);
      }
    }
  }

  send(msg) {
    if (!this.proc) {
      return;
    }
    traceLspMessage('->', msg);
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

// rechSemanticTokensLegend - ДОЛЖНА буквально совпадать (состав и порядок)
// с internal/lsp/server.go, semanticTokenTypes/semanticTokenModifiers -
// индекс имени в этом списке и есть числовое значение, которым сервер
// кодирует тип/модификатор каждого токена (самого текста легенды в ответе
// "textDocument/semanticTokens/full" нет, только числа).
const rechSemanticTokensLegend = new vscode.SemanticTokensLegend(
  ['function', 'type', 'variable', 'parameter', 'property', 'enumMember'],
  ['readonly']
);

// provideRechDocumentSemanticTokens - "data" сервера (internal/lsp/
// semantictokens.go, encodeSemanticTokens) уже в стандартном LSP-формате
// delta-кодирования - том же самом, что ожидает конструктор
// vscode.SemanticTokens, поэтому оборачивается напрямую, без промежуточного
// декодирования через SemanticTokensBuilder.
async function provideRechDocumentSemanticTokens(document) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/semanticTokens/full', {
    textDocument: { uri: document.uri.toString() },
  });
  const data = resp && resp.result ? resp.result.data : null;
  return new vscode.SemanticTokens(new Uint32Array(Array.isArray(data) ? data : []));
}

// provideRechBuiltinSource - содержимое синтетического документа
// "rech-builtin:///<имя>.rech" (см. регистрацию content-провайдера выше) -
// сервер сам знает, встроенная ли это функция вообще (builtindefinition.go,
// builtinStubName/builtinStubSource) - "" (пустой документ), если нет.
async function provideRechBuiltinSource(uri) {
  const resp = await lspClient.request('rech/builtinSource', { uri: uri.toString() });
  return resp && resp.result ? resp.result.content : '';
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

// provideRechImplementation - "textDocument/implementation" (internal/lsp/
// implementation.go) - в отличие от provideRechDefinition, result - МАССИВ
// локаций (интерфейс обычно реализован не одной сущностью), не одна.
async function provideRechImplementation(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/implementation', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map(
    ({ uri, range }) =>
      new vscode.Location(
        vscode.Uri.parse(uri),
        new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
      )
  );
}

// provideRechReferences - "textDocument/references" (internal/lsp/
// occurrences.go) - ограничено ТЕКУЩИМ документом (сервер сам это решает,
// не расширение) - переменная/параметр/функция/сущность/константа модуля;
// у переменной сюда попадают и её падежные словоформы ("паролем" - ссылка
// на переменную "пароль"), не только буквальное совпадение текста. Член
// сущности (receiver.поле) не поддержан - сервер вернёт пустой список (см.
// package doc occurrences.go).
async function provideRechReferences(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/references', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
    context: { includeDeclaration: true },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map(
    ({ uri, range }) =>
      new vscode.Location(
        vscode.Uri.parse(uri),
        new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
      )
  );
}

// provideRechDocumentHighlights - "textDocument/documentHighlight" (internal/
// lsp/occurrences.go) - то же множество вхождений, что и
// provideRechReferences, но без "uri" (запрос документ-локальный по
// определению) - именно эта фича даёт то, что встроенная в VS Code
// подсветка "одинаковых слов" не умеет сама по себе: выделение переменной
// "пароль" подсвечивает и её словоформы ("паролем"), не только буквальные
// совпадения текста.
async function provideRechDocumentHighlights(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/documentHighlight', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map(
    ({ range, kind }) =>
      new vscode.DocumentHighlight(
        new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
        kind === 2 ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Text
      )
  );
}

// provideRechCodeActions - "textDocument/codeAction" (internal/lsp/
// codeaction.go) - сейчас единственный вид - автоимпорт ("Импортировать X
// из..."). Сервер решает не по диапазону/списку диагностик запроса (в
// отличие от типичного LSP-сервера - у документа только одна диагностика
// сразу, см. package doc internal/lsp/document.go), поэтому document/range
// пробрасываются, но их содержимое сервер игнорирует - контракт метода
// всё равно требует их передать.
async function provideRechCodeActions(document, range) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/codeAction', {
    textDocument: { uri: document.uri.toString() },
    range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } },
    context: { diagnostics: [] },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map((item) => {
    const action = new vscode.CodeAction(item.title, vscode.CodeActionKind.QuickFix);
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const [uri, edits] of Object.entries(item.edit.changes)) {
      for (const e of edits) {
        workspaceEdit.replace(
          vscode.Uri.parse(uri),
          new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character),
          e.newText
        );
      }
    }
    action.edit = workspaceEdit;
    return action;
  });
}

// provideRechCodeLenses - "textDocument/codeLens" (internal/lsp/
// codelens.go) - "N ссылок" над каждым объявлением документа, плюс "▶
// запустить тест" над "функция главная" тестового файла. Сервер уже
// присылает готовую команду (title + аргументы) на каждый CodeLens -
// resolveProvider не объявлен (server.go, initialize), значит клиенту не
// нужно вызывать codeLens/resolve отдельно. Два РАЗНЫХ клиентских command,
// с разной формой arguments (см. server.go, handleCodeLens):
// "editor.action.showReferences" (встроенная команда VS Code - uri,
// position, locations) - разбирается и переводится в настоящие
// vscode.Uri/Position/Location; любая другая (сейчас - только
// "rech.runTestFile", registerCommand выше) - аргументы уже готовы как
// есть (путь файла строкой), передаются без изменений.
async function provideRechCodeLenses(document) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/codeLens', {
    textDocument: { uri: document.uri.toString() },
  });
  if (!resp || !Array.isArray(resp.result)) {
    return [];
  }
  return resp.result.map((item) => {
    const range = new vscode.Range(
      item.range.start.line, item.range.start.character,
      item.range.end.line, item.range.end.character
    );
    if (item.command.command !== 'editor.action.showReferences') {
      return new vscode.CodeLens(range, {
        title: item.command.title,
        command: item.command.command,
        arguments: item.command.arguments,
      });
    }
    const [uri, position, locations] = item.command.arguments;
    return new vscode.CodeLens(range, {
      title: item.command.title,
      command: item.command.command,
      arguments: [
        vscode.Uri.parse(uri),
        new vscode.Position(position.line, position.character),
        locations.map(
          (loc) =>
            new vscode.Location(
              vscode.Uri.parse(loc.uri),
              new vscode.Range(loc.range.start.line, loc.range.start.character, loc.range.end.line, loc.range.end.character)
            )
        ),
      ],
    });
  });
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
  17: vscode.CompletionItemKind.File,
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

// provideRechSignatureHelp - "textDocument/signatureHelp" (internal/lsp/
// signaturehelp.go) - ровно одна сигнатура (Rech не различает перегрузки в
// этом смысле, см. её package doc), activeParameter может выйти за длину
// parameters (пользователь напечатал больше аргументов, чем объявлено) -
// vscode сам не подсвечивает ничего в этом случае, безопасно передать как
// есть.
async function provideRechSignatureHelp(document, position) {
  lspClient.syncDocument(document);
  const resp = await lspClient.request('textDocument/signatureHelp', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });
  if (!resp || !resp.result) {
    return null;
  }
  const help = new vscode.SignatureHelp();
  help.signatures = resp.result.signatures.map((sig) => {
    const info = new vscode.SignatureInformation(sig.label);
    info.parameters = sig.parameters.map((p) => new vscode.ParameterInformation(p.label));
    if (sig.documentation) {
      info.documentation = new vscode.MarkdownString(sig.documentation);
    }
    return info;
  });
  help.activeSignature = resp.result.activeSignature;
  help.activeParameter = resp.result.activeParameter;
  return help;
}

module.exports = { activate, deactivate };
