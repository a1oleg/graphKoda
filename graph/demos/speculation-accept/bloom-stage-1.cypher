MATCH (n:DemoStage1)
OPTIONAL MATCH (n)-[r:NEXT]->(m:DemoStage1)
RETURN n, r, m;
