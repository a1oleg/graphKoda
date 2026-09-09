MATCH (demo:ColdKodeDemo {id: 'speculation-accept'})
CALL apoc.cypher.doIt(demo.query, {}) YIELD value
RETURN value.step AS step, value.n AS n, value.r AS r, value.m AS m;
