// Расширение VS Code для языка Rech (github.com/IlyaFeoktistov/Rech).
// Автор: Ilya Feoktistov.
//
// Три команды: "Rech: собрать"/"Rech: собрать и запустить" (через
// child_process, не интерактивный терминал - вывод разбирается на
// диагностику "строка N"), "Rech: запустить тесты" (по каталогу проекта,
// через rech test). "rech.run" запускается в интегрированном терминале,
// а не через child_process - в отличие от build/test, у выполняемой
// Rech-программы может быть собственный интерактивный ввод
// (прочитать_строку и т. п.), терминал даёт ей настоящий stdin.

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
    vscode.commands.registerCommand('rech.test', () => runCaptured('test', { wholeProject: true }))
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

// activeRechFile возвращает путь к .rech-файлу активного редактора, сохраняя
// несохранённые изменения перед сборкой - компилятор видит только то, что
// уже записано на диск, без этого пришлось бы объяснять пользователю, что
// "собрать" смотрит на старую версию файла.
async function activeRechFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rech') {
    vscode.window.showErrorMessage('Rech: нет открытого .rech-файла в активном редакторе.');
    return null;
  }
  await editor.document.save();
  return editor.document;
}

async function runInTerminal(subcommand) {
  const doc = await activeRechFile();
  if (!doc) {
    return;
  }
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal('Rech');
  }
  terminal.show(true);
  const file = quoteArg(doc.fileName);
  terminal.sendText(`${quoteArg(rechPath())} ${subcommand} ${file}`);
}

// runCaptured запускает "rech <subcommand>" через child_process (не
// терминал) - вывод не для интерактивного ввода, а для разбора: строки
// stderr вида "строка N[, столбец M]: ..." становятся диагностикой в
// редакторе на этой строке, весь вывод целиком - в OutputChannel.
// wholeProject - для "rech test" запускает по корню открытой рабочей
// области, а не по одному файлу (тесты обычно разбросаны по каталогу).
async function runCaptured(subcommand, opts = {}) {
  let target, doc;
  if (opts.wholeProject) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) {
      vscode.window.showErrorMessage('Rech: нет открытой рабочей области для "rech test".');
      return;
    }
    target = folder.uri.fsPath;
  } else {
    doc = await activeRechFile();
    if (!doc) {
      return;
    }
    target = doc.fileName;
  }

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`$ ${rechPath()} ${subcommand} ${target}`);

  const result = await execRech([subcommand, target]);
  outputChannel.append(result.stdout);
  outputChannel.append(result.stderr);

  const diagFile = doc ? doc.uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
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

module.exports = { activate, deactivate };
