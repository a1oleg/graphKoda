import { loadAuraContext } from './helpersContext.js';
export const inputRoot = 'screens/REPL.tsx:3142:38:3142:51';
export const inputScope = 'input-terminal-origin';
export function loadInputContext() {
  return loadAuraContext(inputScope, { root: inputRoot, title: 'input: ввод из терминала',
    task: 'Откуда приходит текст при обычной отправке?', completion: 'Происхождение input собрано',
    assumptions: 'Обычный набор и отдельный Enter, режим prompt, без истории, подсказок и команд. Сжатые контекстные переходы проверены по исходникам; это подготовленный маршрут, не запись выполнения и не автоматическое доказательство всех передач.' });
}
