async function runResetQuery(driver, database, query, parameters = {}) {
  const session = driver.session({ database });
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

export async function resetGraphDatabase(driver, database) {
  const startedAt = Date.now();

  const [record] = await runResetQuery(
    driver,
    database,
    `
      MATCH (n)
      CALL (n) {
        DETACH DELETE n
      } IN TRANSACTIONS OF 1000 ROWS
      RETURN count(*) AS total
    `,
  );

  const total = Number(record?.total || 0);

  return {
    ok: true,
    batches: total > 0 ? Math.ceil(total / 1000) : 0,
    total,
    timeTaken: Date.now() - startedAt,
    committedOperations: total,
    failedOperations: 0,
    failedBatches: 0,
    retries: 0,
    errorMessages: null,
  };
}
