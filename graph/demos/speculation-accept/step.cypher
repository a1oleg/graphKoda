MATCH (demo:ColdKodeDemo {id: 'speculation-accept'})
SET demo.clicks = coalesce(demo.clicks, 0) + 1
WITH demo, CASE WHEN demo.clicks < 3 THEN demo.clicks ELSE 3 END AS step
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
    MERGE (entry)-[r:HAS_PARAMETER]->(parameter)
    SET r.index = p.index, r.stage = 1, r.authored = true
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
CALL {
  WITH demo, step
  UNWIND CASE WHEN step >= 2 THEN [
    ['secondary', 'trim'], ['trim', 'readState'], ['readState', 'footerGuard'],
    ['footerGuard', 'agentGuard'], ['agentGuard', 'images'], ['images', 'suggestion'],
    ['suggestion', 'acceptGuard'], ['acceptGuard', 'activeGuard'],
    ['activeGuard', 'mark'], ['mark', 'log'], ['log', 'object']
  ] ELSE [] END AS pair
  MATCH (a:ColdKodeDemoNode {demoId: demo.id, key: pair[0]})
  MATCH (b:ColdKodeDemoNode {demoId: demo.id, key: pair[1]})
  MERGE (a)-[r:DEMO_NEXT]->(b)
  SET r.stage = 2, r.authored = true
  RETURN count(*) AS linked
}
CALL {
  WITH demo, step
  MATCH (n:ColdKodeDemoNode {demoId: demo.id})
  WHERE step >= 2
  FOREACH (_ IN CASE WHEN n.key = 'secondary' THEN [1] ELSE [] END | SET n:DemoFunction)
  FOREACH (_ IN CASE WHEN n.key = 'object' THEN [1] ELSE [] END | SET n:DemoObject)
  FOREACH (_ IN CASE WHEN NOT n.key IN ['primary', 'input', 'helpers', 'specAcc', 'secondary', 'object'] THEN [1] ELSE [] END | SET n:DemoStep)
  RETURN count(*) AS classified
}
CALL {
  WITH demo, step
  MATCH (parameter:ColdKodeDemoNode {demoId: demo.id, key: 'specAcc'})
  MATCH (origin:ColdKodeDemoNode {demoId: demo.id, key: 'object'})
  WHERE step >= 3
  MERGE (parameter)-[r:`создаётся в...`]->(origin)
  SET r.stage = 3, r.authored = true, r.argumentIndex = 2,
      r.evidence = 'onSubmitProp(..., ..., object) -> REPL.onSubmit.speculationAccept',
      r.sourceFile = 'components/PromptInput/PromptInput.tsx',
      r.sourceLine = 1021, r.sourceRevision = demo.sourceRevision,
      r.meaning = 'Object construction, not creation of the state stored inside it'
  RETURN count(*) AS origins
}
WITH demo, step
MATCH (n:ColdKodeDemoNode {demoId: demo.id})
WHERE n.stage <= step
OPTIONAL MATCH (n)-[r]->(m:ColdKodeDemoNode {demoId: demo.id})
WHERE r.stage <= step AND m.stage <= step
RETURN step, n, r, m;
