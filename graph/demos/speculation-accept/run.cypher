MATCH (n {demoId: 'speculation-accept'})
OPTIONAL MATCH (n)-[r:NEXT|VALUE_FROM]->(m {demoId: 'speculation-accept'})
RETURN n, r, m;
