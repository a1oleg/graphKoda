MATCH (demo:ColdKodeDemo {id: 'speculation-accept'})
SET demo.presentation = 'bloom-coordinate-layout'
REMOVE demo.query, demo.clicks
WITH demo, 3 AS step
FOREACH (_ IN CASE WHEN step >= 1 THEN [1] ELSE [] END |
  MERGE (entry:ColdKodeDemoNode {demoId: demo.id, key: 'primary'})
  SET entry:DemoFunction, entry.name = 'REPL.onSubmit', entry.stage = 1,
      entry.file = 'screens/REPL.tsx', entry.line = 3142,
      entry.sourceRevision = demo.sourceRevision, entry.authored = true,
      entry.omittedParameters = ['options']
  FOREACH (p IN [
    {key: 'input', name: 'input: string', index: 0},
    {key: 'helpers', name: 'helpers: PromptInputHelpers', index: 1},
    {key: 'specAcc', name: 'speculationAccept?', index: 2}
  ] |
    MERGE (parameter:ColdKodeDemoNode {demoId: demo.id, key: p.key})
    SET parameter:DemoParameter, parameter.name = p.name, parameter.stage = 1,
        parameter.file = entry.file, parameter.line = 3142,
        parameter.sourceRevision = demo.sourceRevision, parameter.authored = true
    SET parameter.parameterIndex = p.index, parameter.ownerKey = 'primary'
  )
)
FOREACH (_ IN CASE WHEN step >= 2 THEN [1] ELSE [] END |
  FOREACH (item IN [
    {key: 'secondary', name: 'PromptInput.onSubmit', line: 984},
    {key: 'trim', name: 'inputParam.trimEnd()', line: 985},
    {key: 'readState', name: 'state = store.getState()', line: 992},
    {key: 'footerGuard', name: 'footer selection does not block', line: 993},
    {key: 'agentGuard', name: 'not selecting-agent', line: 1000},
    {key: 'images', name: 'hasImages = ...some(image)', line: 1005},
    {key: 'suggestion', name: 'suggestionText; inputMatchesSuggestion', line: 1011},
    {key: 'acceptGuard', name: 'matching suggestion, no images, leader view', line: 1013},
    {key: 'activeGuard', name: "speculation.status === 'active'", line: 1015},
    {key: 'mark', name: 'markAccepted()', line: 1016},
    {key: 'log', name: 'logOutcomeAtSubmission(skipReset: true)', line: 1018},
    {key: 'object', name: '{ state, speculationSessionTimeSavedMs, setAppState }', line: 1025}
  ] |
    MERGE (n:ColdKodeDemoNode {demoId: demo.id, key: item.key})
    SET n.name = item.name, n.stage = 2, n.file = 'components/PromptInput/PromptInput.tsx',
        n.line = item.line, n.sourceRevision = demo.sourceRevision, n.authored = true,
        n.scope = 'Successful active-speculation acceptance path; other branches omitted'
  )
)
WITH demo, step
CALL (demo) {
  MATCH (a:ColdKodeDemoNode {demoId: demo.id})-[r]->(b:ColdKodeDemoNode {demoId: demo.id})
  WHERE type(r) IN ['HAS_PARAMETER', 'DEMO_NEXT', 'создаётся в...']
  DELETE r
  RETURN count(*) AS migrated
}
CALL (demo) {
  UNWIND [['primary', 'input'], ['input', 'helpers'], ['helpers', 'specAcc']] AS pair
  MATCH (a:ColdKodeDemoNode {demoId: demo.id, key: pair[0]})
  MATCH (b:ColdKodeDemoNode {demoId: demo.id, key: pair[1]})
  MERGE (a)-[r:NEXT]->(b)
  SET r.stage = 1, r.revealTag = '01_primary', r.authored = true,
      r.meaning = 'Parameter display order, not execution order'
  RETURN count(*) AS parametersLinked
}
CALL (demo, step) {
  UNWIND CASE WHEN step >= 2 THEN [
    ['secondary', 'trim'], ['trim', 'readState'], ['readState', 'footerGuard'],
    ['footerGuard', 'agentGuard'], ['agentGuard', 'images'], ['images', 'suggestion'],
    ['suggestion', 'acceptGuard'], ['acceptGuard', 'activeGuard'],
    ['activeGuard', 'mark'], ['mark', 'log'], ['log', 'object']
  ] ELSE [] END AS pair
  MATCH (a:ColdKodeDemoNode {demoId: demo.id, key: pair[0]})
  MATCH (b:ColdKodeDemoNode {demoId: demo.id, key: pair[1]})
  MERGE (a)-[r:NEXT]->(b)
  SET r.stage = 2, r.revealTag = '02_secondary', r.authored = true,
      r.meaning = 'Summarized successful acceptance path; other branches omitted'
  RETURN count(*) AS linked
}
CALL (demo, step) {
  MATCH (n:ColdKodeDemoNode {demoId: demo.id})
  WHERE step >= 2
  FOREACH (_ IN CASE WHEN n.key = 'secondary' THEN [1] ELSE [] END | SET n:DemoFunction)
  FOREACH (_ IN CASE WHEN n.key = 'object' THEN [1] ELSE [] END | SET n:DemoObject)
  FOREACH (_ IN CASE WHEN NOT n.key IN ['primary', 'input', 'helpers', 'specAcc', 'secondary', 'object'] THEN [1] ELSE [] END | SET n:DemoStep)
  RETURN count(*) AS classified
}
CALL (demo, step) {
  MATCH (parameter:ColdKodeDemoNode {demoId: demo.id, key: 'specAcc'})
  MATCH (origin:ColdKodeDemoNode {demoId: demo.id, key: 'object'})
  WHERE step >= 3
  MERGE (parameter)-[r:VALUE_FROM]->(origin)
  SET r.stage = 3, r.revealTag = '03_origin', r.authored = true, r.derived = true, r.argumentIndex = 2,
      r.evidence = 'onSubmitProp(..., ..., object) -> REPL.onSubmit.speculationAccept',
      r.sourceFile = 'components/PromptInput/PromptInput.tsx',
      r.sourceLine = 1021, r.sourceRevision = demo.sourceRevision,
      r.meaning = 'Authored origin summary; object construction, not creation of its state field',
      r.evidencePath = 'parameter <- BINDS_TO_PARAMETER - argument - VALUE_FROM -> object'
  RETURN count(*) AS origins
}
WITH demo, step
CALL (demo) {
  UNWIND [
    {keys: ['primary', 'input', 'helpers', 'specAcc'], x: 0, tag: '01_primary', axis: 'REPL.onSubmit'},
    {keys: ['secondary', 'trim', 'readState', 'footerGuard', 'agentGuard', 'images', 'suggestion', 'acceptGuard', 'activeGuard', 'mark', 'log', 'object'], x: 1000, tag: '02_secondary', axis: 'PromptInput.onSubmit'}
  ] AS lane
  UNWIND range(0, size(lane.keys) - 1) AS ordinal
  MATCH (n:ColdKodeDemoNode {demoId: demo.id, key: lane.keys[ordinal]})
  SET n.x = lane.x, n.y = -180 * ordinal, n.ordinal = ordinal,
      n.axis = lane.axis, n.revealTag = lane.tag
  REMOVE n:DemoStage1:DemoStage2
  FOREACH (_ IN CASE WHEN lane.x = 0 THEN [1] ELSE [] END | SET n:DemoStage1)
  FOREACH (_ IN CASE WHEN lane.x = 1000 THEN [1] ELSE [] END | SET n:DemoStage2)
  RETURN count(*) AS positioned
}
MATCH (n:ColdKodeDemoNode {demoId: demo.id})
WHERE n.stage <= step
OPTIONAL MATCH (n)-[r]->(m:ColdKodeDemoNode {demoId: demo.id})
WHERE r.stage <= step AND m.stage <= step
RETURN step, n, r, m;
