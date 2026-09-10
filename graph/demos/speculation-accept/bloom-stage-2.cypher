MATCH (n {demoId: 'speculation-accept'})
WHERE n:DemoStage1 OR n:DemoStage2
OPTIONAL MATCH (n)-[r:NEXT]->(m {demoId: 'speculation-accept'})
WHERE m:DemoStage1 OR m:DemoStage2
RETURN n, r, m;
