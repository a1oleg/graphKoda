MATCH (demo:ColdKodeDemo {id: 'speculation-accept'})
OPTIONAL MATCH (n:ColdKodeDemoNode {demoId: demo.id})
DETACH DELETE n
WITH DISTINCT demo
SET demo.clicks = 0
RETURN demo.clicks AS clicks;
