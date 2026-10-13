import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareCatalog, catalogImportSql, catalogLinkNormalization } from '../shared/catalog-import.mjs';

const run = promisify(execFile);
const option = (name) => process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const input = option('--input');
if (!input) throw new Error('必须显式提供一次性迁移输入 --input=文件路径；应用不会读取此文件。');
const raw = await readFile(input);
const parsed = JSON.parse(raw.toString('utf8'));
const records = prepareCatalog(Array.isArray(parsed) ? parsed : parsed.items);
const update = process.argv.includes('--update');
const digest = createHash('sha256').update(raw).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preview', count: records.length, update, sha256: digest }));
} else {
  const env = option('--env');
  if (env !== 'guoman-d1goxm3hhb53752a4') throw new Error('当前工具只允许已核验的目标PG环境');
  async function execute(sql) {
    const { stdout } = await run('cloudbase', ['db','execute','-e',env,'--sql',sql,'--json'], { maxBuffer: 8 * 1024 * 1024 });
    const response = JSON.parse(stdout).data;
    if (response?.Error || response?.Columns?.[0] !== 'result' || response.Rows?.length !== 1) throw new Error('目录操作结果未确认；先核对数据库再继续');
    return JSON.parse(JSON.parse(response.Rows[0])[0]);
  }
  const stored = await execute("SELECT COALESCE(jsonb_agg(document ORDER BY id COLLATE \"C\"),'[]'::jsonb) AS result FROM guoman_private.documents WHERE collection='guoman_series'");
  if (!Array.isArray(stored) || stored.length > 10000) throw new Error('旧PG目录响应无效');
  const normalizations = catalogLinkNormalization(stored);
  for (let start = 0; start < normalizations.reads.length; start += 50) {
    const batch = { reads: normalizations.reads.slice(start,start+50), writes: normalizations.writes.slice(start,start+50) };
    const hex = Buffer.from(JSON.stringify(batch),'utf8').toString('hex');
    const result = await execute("SELECT guoman_private.commit_documents(convert_from(decode('"+hex+"','hex'),'UTF8')::jsonb) AS result");
    if (result.ok !== true) throw new Error('旧链接规范化存在冲突，未继续导入，请先重读数据库');
  }
  console.log(JSON.stringify({ normalizedLinks: normalizations.writes.length }));
  let changed = 0;
  for (let start = 0; start < records.length; start += 100) {
    const sql = catalogImportSql(records.slice(start,start + 100), { update });
    // 单次调用；不确定结果立即停止，不能自动重放。
    const value = await execute(sql);
    if (!Number.isInteger(value.changed) || value.changed < 0 || value.changed > 100) throw new Error('目录导入计数未确认');
    changed += value.changed;
    console.log(JSON.stringify({ processed: Math.min(start + 100,records.length), changed }));
  }
  console.log(JSON.stringify({ mode: 'applied', count: records.length, changed, update, sha256: digest }));
}
