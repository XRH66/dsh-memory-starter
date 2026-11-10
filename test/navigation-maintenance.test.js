import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, directUser, runPreStep, TARGET_SESSION, toolVaultBackend } from './helpers.js';
import { resolveConfig } from '../lib/config.js';
import { noteMatchesProjectPath } from '../lib/navigation.js';
import { maintainIndexes } from '../lib/maintenance.js';
import { createBridge } from '../lib/index.js';

const factId='personal/chats/facts/用户-评价偏好';
const indexId='personal/index/表达偏好';
const profileId='personal/dafeiyu/thoughts/自我档案';
const oldText='不要评价老大。可以有点皮，正事认真。';
const newText='不必每句话都评价老大，按话题自然回应。可以有点皮，正事认真。';
function seed(store) {
  const add = (permalink,title,content,frontmatter={},tags=[]) => store.notes.set(permalink,{
    permalink,title,content,frontmatter, tags, checksum:'initial-'+permalink, directory:permalink.replace(/^personal\//,'').split('/').slice(0,-1).join('/'),
    filePath:permalink.replace(/^personal\//,'')+'.md',
  });
  add(factId,'用户 - 评价偏好','<!-- dsh-fact-memory -->\n# 用户 - 评价偏好\n\n- [preference] 不要每句话都评价我\n- subject: 用户\n- attribute: 评价偏好\n',
    {memory_id:'fact-1',status:'active',subject:'用户',attribute:'评价偏好',value:'不要每句话都评价我',memory_kind:'fact',recorded_at:'2026-10-24T10:00:00Z'},['dsh-memory']);
  add(indexId,'表达偏好','# 表达偏好\n\n## 不要评价\n- [[用户 - 评价偏好]] —— 永远不许评价\n\n保留我的手写段落。',{},['index','moc']);
  add(profileId,'自我档案','<!-- dafeiyu-record kind=thoughts -->\n# 自我档案\n\n## 10:00\n- 发生日期: 日期未明\n- 记录日期: 2026-10-24 10:00\n'+oldText+'\n\n## 11:00\n- 发生日期: 日期未明\n- 记录日期: 2026-10-24 11:00\n我喜欢白米饭。\n',
    {dafeiyu:'true',dafeiyu_kind:'thoughts',status:'active',recorded_at:'2026-10-24T02:00:00Z'});
}
const plan = JSON.stringify({
  assignments:[],
  headings:[{index:indexId,find:'## 不要评价',replace:'## 评价与回应'}],
  profile:[{entryIndex:1,find:oldText,text:newText}],
});

test('correction synchronizes linked rows and one self-profile entry through existing writer', async () => {
  const store=memoryStore();seed(store);
  const ctx={config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  const result=await maintainIndexes(ctx,[{action:'CORRECT',permalink:factId,memoryId:'fact-1'}]);
  assert.equal(result.updated,1);assert.equal(result.profileUpdated,1);
  assert.match(store.notes.get(indexId).content,/不要每句话都评价我/);
  assert.match(store.notes.get(indexId).content,/保留我的手写段落/);
  assert.doesNotMatch(store.notes.get(indexId).content,/永远不许评价|## 不要评价/);
  assert.match(store.notes.get(profileId).content,/我喜欢白米饭/);
  assert.match(store.notes.get(profileId).content,/可以有点皮，正事认真/);
  assert.match(store.notes.get(profileId).content,/记录日期: 2026-10-24 10:00/);
  assert.equal(store.notes.get(factId).frontmatter.memory_id,'fact-1');
});

test('main project accepts migrated personal permalinks only with matching real paths', async () => {
  const store=memoryStore();seed(store);
  const ctx={config:resolveConfig({project:'main'}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  const result=await maintainIndexes(ctx,[{action:'CORRECT',permalink:factId,memoryId:'fact-1'}]);
  assert.equal(result.updated,1);assert.equal(result.profileUpdated,1);
  assert.equal(store.notes.get(factId).permalink,factId);
  assert.equal(store.notes.get(profileId).permalink,profileId);
  assert.match(store.notes.get(indexId).content,/不要每句话都评价我/);
  assert.match(store.notes.get(profileId).content,/可以有点皮，正事认真/);
});

test('the personal migration alias is limited to main and needs a safe real path', () => {
  const note={permalink:'personal/dafeiyu/thoughts/自我档案',file_path:'dafeiyu/thoughts/自我档案.md'};
  assert.equal(noteMatchesProjectPath(note,'main','dafeiyu/thoughts/自我档案',{exact:true}),true);
  assert.equal(noteMatchesProjectPath(note,'other','dafeiyu/thoughts/自我档案',{exact:true}),false);
  for (const file_path of [path.resolve(os.tmpdir(),'vault','dafeiyu','thoughts','自我档案.md'),'dafeiyu/../elsewhere/自我档案.md','dafeiyu/thoughts/../thoughts/自我档案.md']) {
    assert.equal(noteMatchesProjectPath({...note,file_path},'main','dafeiyu/thoughts/自我档案',{exact:true}),false);
  }
});

test('main project rejects a legacy permalink whose real file path is elsewhere', async () => {
  const store=memoryStore();seed(store);
  store.notes.get(profileId).filePath='dafeiyu/thoughts/别人的档案.md';
  const ctx={config:resolveConfig({project:'main'}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/INVALID_SELF_PROFILE/);
  store.notes.get(profileId).filePath='dafeiyu/thoughts/自我档案.md';
  store.notes.get(profileId).permalink='other/dafeiyu/thoughts/自我档案';
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/INVALID_SELF_PROFILE/);
});

test('a concurrent index edit is preserved and reported for retry', async () => {
  const store=memoryStore();seed(store);
  const llm={async *stream(){
    store.notes.get(indexId).content+='\n用户刚补的内容';
    store.notes.get(indexId).checksum='concurrent-change';
    yield {type:'text-delta',text:plan};
  }};
  await assert.rejects(maintainIndexes({config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm},[{action:'CORRECT',permalink:factId}]),/WRITE_CONFLICT/);
  assert.match(store.notes.get(indexId).content,/用户刚补的内容/);
  assert.match(store.notes.get(profileId).content,/不要评价老大/);
});

test('profile read failure and invalid ownership stay failures instead of reporting successful sync', async () => {
  const store=memoryStore();seed(store);
  const base=store.tools;
  let offline=true;
  const tools={get vaultBackend(){return toolVaultBackend(this);},get(name,agent){const d=base.get(name,agent);return {...d,execute:async(args,exec)=>{
    if(name.endsWith('__read_note') && args.identifier===profileId && offline) throw new Error('connection unavailable');
    return d.execute(args,exec);
  }};}};
  const ctx={config:resolveConfig({}),tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/MEMORY_TOOL_FAILED/);
  assert.match(store.notes.get(indexId).content,/永远不许评价/);
  offline=false;store.notes.get(profileId).content='# not a managed profile';
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/INVALID_SELF_PROFILE/);
});

test('a source changed while planning cannot apply an obsolete correction', async () => {
  const store=memoryStore();seed(store);
  const llm={async *stream(){store.notes.get(factId).checksum='new-source';yield {type:'text-delta',text:plan};}};
  await assert.rejects(maintainIndexes({config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm},[{action:'CORRECT',permalink:factId}]),/SOURCE_CHANGED/);
  assert.match(store.notes.get(indexId).content,/永远不许评价/);
  assert.match(store.notes.get(profileId).content,/不要评价老大/);
});

