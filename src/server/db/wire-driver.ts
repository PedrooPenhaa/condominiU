import net from 'node:net';
import type { Client, Db, Row } from './index.ts';

/**
 * Cliente Postgres mínimo, só para testes e demonstração local em um banco sem senha
 * (autenticação trust). Em produção o sistema usa o pacote pg.
 * Endereço: wire://usuario@host:porta/banco
 */
class Connection {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private waiters: Array<(m: { type: string; body: Buffer }) => void> = [];
  private inbox: Array<{ type: string; body: Buffer }> = [];

  constructor(host: string, port: number) {
    this.socket = net.connect(port, host);
    this.socket.on('data', (chunk) => this.onData(chunk as Buffer));
    this.socket.on('error', () => undefined);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < length + 1) return;
      const message = { type: String.fromCharCode(this.buffer[0]!), body: this.buffer.subarray(5, length + 1) };
      this.buffer = this.buffer.subarray(length + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
    }
  }

  private next() {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<{ type: string; body: Buffer }>((resolve) => this.waiters.push(resolve));
  }

  private send(type: string, body: Buffer) {
    const header = Buffer.alloc(5);
    header.write(type, 0, 'latin1');
    header.writeInt32BE(body.length + 4, 1);
    this.socket.write(Buffer.concat([header, body]));
  }

  async start(user: string, database: string) {
    const params = Buffer.from(`user\0${user}\0database\0${database}\0client_encoding\0UTF8\0\0`);
    const packet = Buffer.alloc(8 + params.length);
    packet.writeInt32BE(packet.length, 0);
    packet.writeInt32BE(196608, 4);
    params.copy(packet, 8);
    this.socket.write(packet);
    for (;;) {
      const message = await this.next();
      if (message.type === 'E') throw new Error(parseError(message.body));
      if (message.type === 'R' && message.body.readInt32BE(0) !== 0) {
        throw new Error('O cliente local só aceita banco sem senha');
      }
      if (message.type === 'Z') return;
    }
  }

  async simple(sql: string) {
    this.send('Q', Buffer.from(`${sql}\0`));
    let failure: string | undefined;
    for (;;) {
      const message = await this.next();
      if (message.type === 'E') failure = parseError(message.body);
      if (message.type === 'Z') break;
    }
    if (failure) throw new Error(failure);
  }

  async extended(sql: string, params: unknown[]) {
    this.send('P', Buffer.concat([Buffer.from(`\0${sql}\0`), Buffer.from([0, 0])]));
    const parts: Buffer[] = [Buffer.from([0, 0, 0, 0]), int16(params.length)];
    for (const param of params) {
      const text = toText(param);
      if (text === null) parts.push(int32(-1));
      else {
        const encoded = Buffer.from(text);
        parts.push(int32(encoded.length), encoded);
      }
    }
    parts.push(Buffer.from([0, 0]));
    this.send('B', Buffer.concat(parts));
    this.send('D', Buffer.from([0x50, 0]));
    this.send('E', Buffer.concat([Buffer.from([0]), int32(0)]));
    this.send('S', Buffer.alloc(0));

    let columns: Array<{ name: string; oid: number }> = [];
    const rows: Row[] = [];
    let failure: { message: string; code?: string } | undefined;
    for (;;) {
      const message = await this.next();
      if (message.type === 'E') failure = { message: parseError(message.body), code: parseCode(message.body) };
      if (message.type === 'T') columns = parseColumns(message.body);
      if (message.type === 'D') rows.push(parseRow(message.body, columns));
      if (message.type === 'Z') break;
    }
    if (failure) {
      const error = new Error(failure.message) as Error & { code?: string };
      error.code = failure.code;
      throw error;
    }
    return rows;
  }

  close() {
    this.send('X', Buffer.alloc(0));
    this.socket.end();
  }
}

function int16(v: number) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b;
}
function int32(v: number) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
}
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function fields(body: Buffer) {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]!);
    const end = body.indexOf(0, i + 1);
    out[code] = body.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return out;
}
function parseError(body: Buffer) {
  return fields(body).M ?? 'Erro do banco';
}
function parseCode(body: Buffer) {
  return fields(body).C;
}
function parseColumns(body: Buffer) {
  const count = body.readInt16BE(0);
  const columns: Array<{ name: string; oid: number }> = [];
  let i = 2;
  for (let c = 0; c < count; c++) {
    const end = body.indexOf(0, i);
    columns.push({ name: body.toString('utf8', i, end), oid: body.readInt32BE(end + 7) });
    i = end + 19;
  }
  return columns;
}
function parseRow(body: Buffer, columns: Array<{ name: string; oid: number }>) {
  const row: Row = {};
  const count = body.readInt16BE(0);
  let i = 2;
  for (let c = 0; c < count; c++) {
    const length = body.readInt32BE(i);
    i += 4;
    const column = columns[c]!;
    if (length === -1) row[column.name] = null;
    else {
      row[column.name] = convert(body.toString('utf8', i, i + length), column.oid);
      i += length;
    }
  }
  return row;
}
// Mesmas conversões do pacote pg com as regras de pg-driver.ts
function convert(text: string, oid: number): unknown {
  if (oid === 16) return text === 't';
  if (oid === 21 || oid === 23 || oid === 26) return Number(text);
  if (oid === 114 || oid === 3802) return JSON.parse(text);
  return text;
}

export async function createWireDb(url: string): Promise<Db> {
  const parsed = new URL(url.replace('wire://', 'http://'));
  const user = parsed.username;
  const database = parsed.pathname.slice(1);
  const free: Connection[] = [];

  const acquire = async () => {
    const existing = free.pop();
    if (existing) return existing;
    const connection = new Connection(parsed.hostname, Number(parsed.port || 5432));
    await connection.start(user, database);
    return connection;
  };

  return {
    async tx(fn) {
      const connection = await acquire();
      const client: Client = {
        query: async <T extends Row>(sql: string, params: unknown[] = []) =>
          (await connection.extended(sql, params)) as T[],
        exec: (sql) => connection.simple(sql),
      };
      try {
        await connection.simple('BEGIN');
        const result = await fn(client);
        await connection.simple('COMMIT');
        return result;
      } catch (error) {
        await connection.simple('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        free.push(connection);
      }
    },
    async close() {
      for (const connection of free.splice(0)) connection.close();
    },
  };
}
