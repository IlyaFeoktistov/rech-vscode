// Расширение VS Code для языка Rech (github.com/IlyaFeoktistov/Rech).
// Автор: Ilya Feoktistov.
//
// Команды "Rech: собрать"/"Rech: собрать и запустить"/"Rech: отладить" (через
// child_process, не интерактивный терминал - вывод разбирается на
// диагностику "строка N"), "Rech: запустить тесты" (по каталогу проекта,
// через rech test). "rech.run" запускается в интегрированном терминале,
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

const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

let diagnostics;
let outputChannel;
let terminal;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('rech');
  outputChannel = vscode.window.createOutputChannel('Rech');
  context.subscriptions.push(diagnostics, outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('rech.build', () => runCaptured('build')),
    vscode.commands.registerCommand('rech.run', () => runInTerminal('run')),
    vscode.commands.registerCommand('rech.test', () => runCaptured('test', { wholeProject: true })),
    vscode.commands.registerCommand('rech.debug', () => startDebugging()),
    vscode.debug.registerDebugConfigurationProvider('rech', new RechDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory('rech', new RechDebugAdapterDescriptorFactory())
  );
}

function deactivate() {
  if (terminal) {
    terminal.dispose();
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

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`$ ${rechPath()} ${subcommand} ${target}`);

  const result = await execRech([subcommand, target]);
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

module.exports = { activate, deactivate };
