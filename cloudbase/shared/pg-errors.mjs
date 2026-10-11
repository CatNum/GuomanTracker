/** A submitted PG commit may have applied even when its response was lost. */
export class CommitUnconfirmedError extends Error {
  constructor(cause) {
    super('保存结果未确认，请刷新记录', { cause });
    this.name = 'CommitUnconfirmedError';
    this.code = 'TX_OUTCOME_UNKNOWN';
  }
}
