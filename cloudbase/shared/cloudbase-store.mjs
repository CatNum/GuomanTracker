import { COLLECTIONS } from './user-service.mjs';

function unwrap(result) {
  if (result?.code) throw result;
  const value = Array.isArray(result?.data) ? result.data[0] : result?.data;
  return value ?? null;
}

/** Minimal CloudBase Node SDK boundary: document-only operations inside transactions. */
export function createCloudbaseStore(db) {
  function boundary(database) {
    return {
      async get(collection, id) {
        try { return unwrap(await database.collection(collection).doc(id).get()); }
        catch (error) {
          if (['DOCUMENT_NOT_FOUND', 'DATABASE_DOCUMENT_NOT_FOUND'].includes(error?.code)) return null;
          throw error;
        }
      },
      async put(collection, id, data) {
        const { _id, ...document } = data;
        const result = await database.collection(collection).doc(id).set(document);
        if (result?.code) throw result;
      },
      async remove(collection, id) {
        const result = await database.collection(collection).doc(id).remove();
        if (result?.code) throw result;
      },
    };
  }
  return {
    ...boundary(db),
    async listFollows(owner) {
      const records = [];
      // Node SDK caps a query at 1000; page to avoid silently dropping older follows.
      for (let skip = 0; ; skip += 100) {
        const result = await db.collection(COLLECTIONS.watch).where({ owner, kind: 'follow' }).orderBy('_id', 'asc').skip(skip).limit(100).get();
        if (result?.code) throw result;
        const page = result?.data ?? [];
        records.push(...page);
        if (page.length < 100) break;
      }
      return records;
    },
    async transaction(callback) { return db.runTransaction((transaction) => callback(boundary(transaction))); },
  };
}
