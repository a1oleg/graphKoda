// Clear the Bloom Scene before running this read-only first stage.
MATCH (n:DemoStage1)
OPTIONAL MATCH (n)-[r:NEXT]->(m:DemoStage1)
RETURN n, r, m;
