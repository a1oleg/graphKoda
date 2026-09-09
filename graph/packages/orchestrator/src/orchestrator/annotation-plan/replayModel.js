// Authored scenario, not a discovered graph or recorded runtime execution.
export const scenario = {
  root: 'input',
  assumptions: 'Три выбранных случая: текст с Enter в одном событии; найденная запись с диска; активная command-привязка. Обычная отправка лидеру, без Vim и подсказки следующего запроса.',
  nodes: [
    { id:'input', title:'onSubmit.input', file:'screens/REPL.tsx', line:3142, deps:['typed','history','command'],
      relations: {"typed":"передаётся из…","history":"получает значение из…","command":"формируется в…"},
      syntax: {"description":"Параметр функции","parts":[["onSubmit","function"],[".","punctuation"],["input","value"]]},
      need:'Откуда приходит отправляемая строка?',
      result:'Отправляемая строка может происходить из набранного текста, выбранной записи истории или команды горячей клавиши. Она не обязательно совпадает с текущим содержимым поля ввода.' },
    { id:'typed', title:'PromptInput.onSubmit', file:'components/PromptInput/PromptInput.tsx', line:1100, deps:['text'],
      relations: {"text":"получает текст через…"},
      syntax: {"description":"Локальная функция","parts":[["PromptInput","function"],[".","punctuation"],["onSubmit","function"]]},
      need:'Как получен inputParam в выбранной ветке ввода?',
      result:'В обычной ветке отправки лидеру PromptInput передаёт подготовленный inputParam в onSubmitProp вместе с helpers.' },
    { id:'text', title:'useTextInput', file:'hooks/useTextInput.ts', line:477, deps:['events'],
      relations: {"events":"получает события через…"},
      syntax: {"description":"Функция-хук","parts":[["useTextInput","function"]]},
      need:'Как событие ввода превращается в отправляемый текст?',
      result:'mapKey применяет ввод к модели Cursor. В выбранном случае текста с завершающим Enter callback onSubmit получает nextCursor.text. Передача callback идёт через TextInput и baseProps.' },
    { id:'events', title:'useInput / App', file:'ink/hooks/use-input.ts', line:68, deps:['stdin'],
      relations: {"stdin":"получает ввод из…"},
      syntax: {"description":"Функция-хук / компонент","parts":[["useInput","function"],[" / ","punctuation"],["App","function"]]},
      need:'Кто доставляет input и key обработчику?',
      result:'Ink разбирает прочитанный ввод и публикует событие input. useInput передаёт его inputHandler, если обработчик активен. Это событийная передача, а не прямой вызов из PromptInput.',
      sources:[['ink/components/App.tsx',311],['ink/components/App.tsx',507]] },
    { id:'stdin', title:'Node.js · stdin.read', file:'ink/components/App.tsx', line:344, deps:[], system:true,
      syntax: {"description":"Метод объекта","parts":[["Node.js","type"],[" · ","punctuation"],["stdin","value"],[".","punctuation"],["read","function"]]},
      need:'Граница получения внешних данных.', result:'Node.js читает данные входного потока терминала. Здесь заканчивается выбранный путь к внешнему источнику; смысл текста определяется выше.' },
    { id:'history', title:'PromptInput · entry.display', file:'components/PromptInput/PromptInput.tsx', line:357, deps:['search'],
      relations: {"search":"передаётся из…"},
      syntax: {"description":"Свойство объекта","parts":[["PromptInput","function"],[" · ","punctuation"],["entry","value"],[".","punctuation"],["display","value"]]},
      need:'Как выбранная запись попадает в отправку?', result:'Callback поиска истории передаёт entry.display в локальный onSubmit, а тот в обычной ветке вызывает onSubmitProp. Вставленные материалы передаются отдельно.' },
    { id:'search', title:'useHistorySearch', file:'hooks/useHistorySearch.ts', line:211, deps:['reader'],
      relations: {"reader":"получает записи из…"},
      syntax: {"description":"Функция-хук","parts":[["useHistorySearch","function"]]},
      need:'Откуда взялось найденное совпадение?', result:'Для непустого поиска с historyMatch обработчик execute извлекает текст записи, отделяет режим и передаёт результат в onAcceptHistory. Выбран сценарий найденной записи, не возврат originalInput.' },
    { id:'reader', title:'makeHistoryReader', file:'history.ts', line:145, deps:['lines'],
      relations: {"lines":"читает строки через…"},
      syntax: {"description":"Асинхронная функция-генератор","parts":[["makeHistoryReader","function"]]},
      need:'Как журнал становится записью истории?', result:'Генератор преобразует LogEntry в HistoryEntry с display и pastedContents. Здесь выбран путь записей с диска; очередь ещё не сброшенных записей в этот сценарий не входит.', sources:[['history.ts',106],['history.ts',265]] },
    { id:'lines', title:'readLinesReverse', file:'utils/fsOperations.ts', line:722, deps:['file'],
      relations: {"file":"читает байты через…"},
      syntax: {"description":"Асинхронная функция-генератор","parts":[["readLinesReverse","function"]]},
      need:'Как поступает содержимое history.jsonl?', result:'Файл читается блоками с конца и выдаётся строками. makeLogEntryReader разбирает строки журнала и отбрасывает неподходящие записи.' },
    { id:'file', title:'Node.js · FileHandle.read', file:'utils/fsOperations.ts', line:741, deps:[], system:true,
      syntax: {"description":"Метод объекта","parts":[["Node.js","type"],[" · ","punctuation"],["FileHandle","type"],[".","punctuation"],["read","function"]]},
      need:'Граница чтения сохранённых данных.', result:'FileHandle.read получает байты файла истории. Это источник сохранённого текста, а не новое событие набора.' },
    { id:'command', title:'CommandKeybindingHandlers', file:'hooks/useCommandKeybindings.tsx', line:77, deps:['keys'],
      relations: {"keys":"регистрирует обработчики через…"},
      syntax: {"description":"Функция-компонент","parts":[["CommandKeybindingHandlers","function"]]},
      need:'Почему отправляется команда, а не текст поля?', result:'Для выбранной binding.action вида command:… обработчик формирует /commandName и вызывает onSubmit с fromKeybinding=true. Строка берётся из привязки; событие клавиатуры только запускает её.' },
    { id:'keys', title:'useKeybindings', file:'keybindings/useKeybinding.ts', line:160, deps:['events'],
      relations: {"events":"получает события через…"},
      syntax: {"description":"Функция-хук","parts":[["useKeybindings","function"]]},
      need:'Что запускает выбранный обработчик команды?', result:'Активный обработчик разрешает сочетание клавиш через контекст привязок и вызывает соответствующую функцию. В сценарии привязка заранее выбрана; её загрузка из настроек не исследуется.' },
  ],
};

export function buildFrames(model = scenario) {
  const byId = new Map(model.nodes.map(n => [n.id,n]));
  if (byId.size !== model.nodes.length || !byId.has(model.root)) throw new Error('Invalid scenario root or duplicate node');
  const frames=[], stack=[], ready=new Set(), traversed=new Set();
  const snapshot = (kind,id,edge=null,fromId=null) => frames.push({kind,id,edge,fromId,stack:[...stack],ready:[...ready],traversed:[...traversed]});
  snapshot('idle',model.root);
  function visit(id, fromId=null) {
    const n=byId.get(id);
    if (!n) throw new Error(`Missing dependency ${id}`);
    if (stack.includes(id)) throw new Error(`Scenario cycle ${id}`);
    const incoming=fromId===null?null:`${fromId}:${id}`;
    if (incoming) traversed.add(incoming);
    if (ready.has(id)) { snapshot('cached',id,incoming,fromId); return; }
    stack.push(id); snapshot(incoming?'descend':'enter',id,incoming,fromId);
    for (const child of n.deps) {
      const edge=`${id}:${child}`;
      visit(child,id);
      snapshot('receive',id,edge);
    }
    ready.add(id); snapshot(n.system?'boundary':'synthesize',id);
    stack.pop();
  }
  visit(model.root); snapshot('complete',model.root);
  return frames;
}

export function buildSequence(model, frames = buildFrames(model)) {
  const participants = [...new Set(frames.map(frame => frame.id))];
  const laneX = new Map(participants.map((id, i) => [id, 120 + i * 240]));
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const elements = [];
  for (const id of participants) {
    elements.push({ data: { id, subject: id, label: byId.get(id).title },
      position: { x: laneX.get(id), y: 60 }, classes: 'participant' });
    elements.push({ data: { id: `end-${id}`, subject: id },
      position: { x: laneX.get(id), y: 120 + frames.length * 64 }, classes: 'anchor' });
    elements.push({ data: { id: `axis-${id}`, source: id, target: `end-${id}` }, classes: 'lifeline' });
  }
  frames.forEach((frame, i) => {
    const y = 120 + i * 64;
    const labels = { idle: 'Начало', enter: 'Контекст', cached: 'Из кэша',
      boundary: 'Граница', synthesize: 'Аннотация готова', complete: 'Готово' };
    const event = `event-${i}`;
    elements.push({ data: { id: event, subject: frame.id, frame: i, label: labels[frame.kind] || '' },
      position: { x: laneX.get(frame.id), y }, classes: 'event' });
    if (!frame.edge) return;
    const returning = frame.kind === 'receive';
    const child = returning
      ? byId.get(frame.id).deps.find(id => `${frame.id}:${id}` === frame.edge)
      : frame.fromId;
    if (!child) throw new Error(`Missing sequence addressee: ${frame.edge}`);
    const peer = `peer-${i}`;
    elements.push({ data: { id: peer, subject: child, frame: i },
      position: { x: laneX.get(child), y }, classes: 'anchor' });
    elements.push({ data: { id: `message-${i}`, frame: i,
      source: peer, target: event,
      label: !returning
        ? byId.get(child).relations?.[frame.id] || '' : '' }, classes: returning ? 'message reply' : 'message' });
  });
  return elements;
}

export function accumulatedContexts(model, frames, index) {
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const received = new Map(model.nodes.map(node => [node.id, new Set()]));
  const visited = new Set();
  const readyAt = new Map();
  for (const [step, frame] of frames.slice(0, index + 1).entries()) {
    visited.add(frame.id);
    for (const id of frame.ready) {
      if (!readyAt.has(id)) readyAt.set(id, step);
    }
    if (frame.kind !== 'receive') continue;
    const child = byId.get(frame.id).deps.find(id => `${frame.id}:${id}` === frame.edge);
    if (child) received.get(frame.id).add(child);
  }
  const ready = new Set(frames[index].ready);
  return model.nodes.filter(node => visited.has(node.id)).map(node => ({
    id: node.id,
    ready: ready.has(node.id),
    readyAt: readyAt.get(node.id) ?? null,
    dependencies: [...received.get(node.id)].map(id => byId.get(id)),
    result: ready.has(node.id) ? node.result : null,
  }));
}
