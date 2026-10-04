// Tiny SELECT builder. It only covers what the reporting queries need: pick
// columns, a table, optional equality filters, optional ordering and a limit.
// Anything more complex is written by hand in the calling model.

type Op = 'eq' | 'gt' | 'lt' | 'gte';

export class SelectBuilder {
  private columns: string[] = ['*'];
  private table = '';
  private filters: string[] = [];
  private params: unknown[] = [];
  private orderBy: string | null = null;
  private limitValue: number | null = null;

  from(table: string): this {
    this.table = table;
    return this;
  }

  select(...columns: string[]): this {
    this.columns = columns;
    return this;
  }

  where(column: string, op: Op, value: unknown): this {
    const operators: Record<Op, string> = { eq: '=', gt: '>', lt: '<', gte: '>=' };
    this.params.push(value);
    this.filters.push(`${column} ${operators[op]} $${this.params.length}`);
    return this;
  }

  order(column: string, direction: 'ASC' | 'DESC' = 'DESC'): this {
    this.orderBy = `${column} ${direction}`;
    return this;
  }

  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  build(): { sql: string; params: unknown[] } {
    if (!this.table) throw new Error('SelectBuilder: from() is required');
    let sql = `SELECT ${this.columns.join(', ')} FROM ${this.table}`;
    if (this.filters.length) sql += ` WHERE ${this.filters.join(' AND ')}`;
    if (this.orderBy) sql += ` ORDER BY ${this.orderBy}`;
    if (this.limitValue !== null) sql += ` LIMIT ${this.limitValue}`;
    return { sql, params: this.params };
  }
}

export function select(): SelectBuilder {
  return new SelectBuilder();
}
