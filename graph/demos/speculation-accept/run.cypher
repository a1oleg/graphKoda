MATCH (n:ColdKodeDemoNode {demoId: 'speculation-accept'})
OPTIONAL MATCH (n)-[r:NEXT|VALUE_FROM]->(m:ColdKodeDemoNode {demoId: 'speculation-accept'})
RETURN n, r, m;
