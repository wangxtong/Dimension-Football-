import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTelegramPublication,beijingTime,TELEGRAM_SITE_ORIGIN,TELEGRAM_TEXT_LIMIT} from '../telegram-presentation.mjs';
import {sampleReport,sampleReceipt,NOW} from './fixtures.mjs';

test('status summary is Chinese, Beijing time and always BLOCKED without publishing probabilities',()=>{
  const report=sampleReport(),receipt=sampleReceipt(report),before=JSON.stringify({report,receipt});
  const value=formatTelegramPublication({report,receipt,now:NOW,releaseGate:'GREEN'});
  assert.equal(value.parse_mode,'HTML');assert.equal(value.link_preview_options.is_disabled,true);
  assert.match(value.text,/发布门禁：暂不放行/);assert.match(value.text,/正式推荐未发布/);
  assert.match(value.text,/2026-10-31 20:00（北京时间）/);assert.match(value.text,/可评估 2 场 · 暂不可评估 1 场/);
  assert.match(value.text,/严格条件.*1 场满足报告内条件，均未获准发布/);
  assert.doesNotMatch(value.text,/%|主胜 50|下注|概率已校准|GREEN/);
  assert.equal(JSON.stringify({report,receipt}),before);
});
test('buttons are working URL links on the existing Site with no unhandled callbacks',()=>{
  const value=formatTelegramPublication({report:sampleReport(),now:NOW});
  const buttons=value.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(b=>new URL(b.url).hash),['#schedule','#analysis','#strict','#missing','#status']);
  assert.ok(buttons.every(b=>new URL(b.url).origin===TELEGRAM_SITE_ORIGIN&&!Object.hasOwn(b,'callback_data')));
  for(const siteURL of ['https://attacker.example',TELEGRAM_SITE_ORIGIN+'/?redirect=evil',TELEGRAM_SITE_ORIGIN+'/#fake'])
    assert.throws(()=>formatTelegramPublication({report:sampleReport(),siteURL,now:NOW}),/ORIGIN_INVALID/);
});
test('HTML is escaped before assembly and long astral names never split entities or surrogate pairs',()=>{
  const report=sampleReport();
  for(const row of report.fixtures){row.forecast={status:'unavailable',reasons:['HISTORY_UNAVAILABLE']};row.fixture.home='<b>&"\'😀'.repeat(25);row.fixture.away='&<>😀'.repeat(35);}
  const value=formatTelegramPublication({report,now:NOW});
  assert.ok(value.text.length<=TELEGRAM_TEXT_LIMIT);assert.equal(value.text.isWellFormed(),true);
  assert.match(value.text,/&lt;b&gt;&amp;&quot;&#39;😀/);assert.doesNotMatch(value.text,/<b>&/);
  assert.equal((value.text.match(/<b>/g)||[]).length,(value.text.match(/<\/b>/g)||[]).length);
  assert.equal((value.text.match(/<a /g)||[]).length,(value.text.match(/<\/a>/g)||[]).length);
  assert.doesNotMatch(value.text,/&(?!amp;|lt;|gt;|quot;|#39;)/);
});
test('expired and started rows are never described as currently evaluable or strict candidates',()=>{
  const report=sampleReport();
  const expired=formatTelegramPublication({report,now:NOW+3600001});
  assert.match(expired.text,/可评估 0 场/);assert.match(expired.text,/严格条件.*0 场/);
  assert.match(expired.text,/预测已过期/);assert.doesNotMatch(expired.text,/%/);
  const started=formatTelegramPublication({report,now:NOW+7200001});
  assert.match(started.text,/比赛已开始或状态已改变/);
});
test('receipt claims require the same report and servedVerified before displaying website success',()=>{
  const report=sampleReport(),receipt=sampleReceipt(report);
  assert.match(formatTelegramPublication({report,receipt,now:NOW}).text,/尚未完成同报告回读/);
  receipt.channels.externalWebsite={status:'published',servedVerified:true,reportId:report.publication.reportId};
  assert.match(formatTelegramPublication({report,receipt,now:NOW}).text,/该报告已完成同报告回读/);
  receipt.reportId='f'.repeat(64);
  assert.throws(()=>formatTelegramPublication({report,receipt,now:NOW}),/RECEIPT_SCHEMA_INVALID/);
});
test('missing-data rows use known Chinese team names and safe fallback reasons',()=>{
  const report=sampleReport();report.fixtures[2].fixture.home='Bayern Munich';
  report.fixtures[2].forecast.reasons=['UNRECOGNIZED_<script>'];
  const value=formatTelegramPublication({report,now:NOW});
  assert.match(value.text,/拜仁慕尼黑/);assert.match(value.text,/数据条件尚未满足/);assert.doesNotMatch(value.text,/script/);
  assert.equal(beijingTime('2026-10-31T20:30:00Z'),'2026-11-01 04:30（北京时间）');
});
