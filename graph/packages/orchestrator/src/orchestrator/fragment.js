import neo4j from 'neo4j-driver';

const TYPE_LABELS = [
  ['Function', 'function'],
  ['Loop', 'loop'],
  ['Branch', 'branch'],
  ['LocalValue', 'variable-path'],
  ['Variable', 'variable-path'],
  ['ValueAccess', 'variable-path'],
  ['Expression', 'expression'],
  ['Operand', 'expression'],
  ['Setting', 'external'],
  ['UiSurface', 'external'],
  ['ExternalTarget', 'external'],
];

export class Fragment {
  constructor({ driver, database, headID, labels = [] } = {}) {
    this.driver = driver;
    this.database = database;
    this.headID = String(headID || '').trim();
    this.labels = Array.isArray(labels) ? labels.map(String) : [];
    this.type = Fragment.typeFromLabels(this.labels);
    this.annotation = null;
  }

  static typeFromLabels(labels = []) {
    const labelSet = new Set(labels.map(String));
    return TYPE_LABELS.find(([label]) => labelSet.has(label))?.[1] || 'node';
  }

  async resolveHead() {
    if (!this.headID) throw new Error('Fragment headID is required.');
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(`
        MATCH (head {stableId: $headID})
        RETURN labels(head) AS labels, head.resource_kind AS resourceKind
        LIMIT 1
      `, { headID: this.headID });
      const record = result.records[0];
      if (!record) return null;
      this.labels = record.get('labels') || [];
      this.type = record.get('resourceKind') ? 'external' : Fragment.typeFromLabels(this.labels);
      return this;
    } finally {
      await session.close();
    }
  }

  async upsertAnnotation(text, {
    source = 'codex',
    toolGitCommitShortHash = null,
    maxDepth = null,
  } = {}) {
    const annotationText = String(text || '').trim();
    if (!annotationText) throw new Error('Fragment annotation text is required.');
    if (!(await this.resolveHead())) {
      return { ok: true, storage: 'annotation-node', updated: 0, headID: this.headID };
    }

    const updatedAt = new Date().toISOString();
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(`
        MATCH (head {stableId: $headID})
        MERGE (head)-[:HAS_ANNOTATION]->(annotation:Annotation {headID: $headID})
        SET annotation.text = $text,
            annotation.type = $type,
            annotation.source = $source,
            annotation.toolGitCommitShortHash = $toolGitCommitShortHash,
            annotation.maxDepth = $maxDepth,
            annotation.updatedAt = $updatedAt
        REMOVE head.graph_annotation_text,
               head.graph_annotation_updated_at,
               head.graph_annotation_source
        RETURN count(annotation) AS updated
      `, {
        headID: this.headID,
        text: annotationText,
        type: this.type,
        source,
        toolGitCommitShortHash,
        maxDepth,
        updatedAt,
      });
      const updated = result.records[0]?.get('updated')?.toNumber?.() ?? 0;
      this.annotation = {
        text: annotationText,
        type: this.type,
        source,
        toolGitCommitShortHash,
        maxDepth,
        updatedAt,
      };
      return {
        ok: true,
        storage: 'annotation-node',
        updated,
        headID: this.headID,
        type: this.type,
        toolGitCommitShortHash,
        maxDepth,
      };
    } finally {
      await session.close();
    }
  }

  static async loadAnnotations(driver, database) {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(`
        MATCH (head)-[:HAS_ANNOTATION]->(annotation:Annotation)
        WHERE head.stableId IS NOT NULL
          AND (annotation.status = 'ready' OR annotation.status IS NULL)
        WITH head, annotation
        ORDER BY annotation.updatedAt DESC
        WITH head, collect(annotation)[0] AS annotation
        RETURN head.stableId AS key,
               annotation.text AS text,
               annotation.type AS type,
               annotation.annotationKind AS annotationKind,
               annotation.annotationId AS annotationId,
               annotation.profileId AS profileId,
               annotation.profileVersion AS profileVersion,
               annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
               annotation.maxDepth AS maxDepth,
               annotation.updatedAt AS updatedAt,
               labels(head) AS labels
      `);
      const annotations = {};
      for (const record of result.records) {
        const labels = record.get('labels') || [];
        annotations[record.get('key')] = {
          text: record.get('text'),
          type: record.get('type') || Fragment.typeFromLabels(labels),
          annotationKind: record.get('annotationKind') || null,
          annotationId: record.get('annotationId') || null,
          profileId: record.get('profileId') || null,
          profileVersion: record.get('profileVersion')?.toNumber?.() ?? record.get('profileVersion') ?? null,
          toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
          maxDepth: record.get('maxDepth')?.toNumber?.() ?? record.get('maxDepth') ?? null,
          updatedAt: record.get('updatedAt') || null,
          storage: 'annotation-node',
          labels,
        };
      }
      return annotations;
    } finally {
      await session.close();
    }
  }
}
