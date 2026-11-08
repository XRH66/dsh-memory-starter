import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatConnectionResolver} from '../lib/chat-connection.js';

test('live endpoint changes invalidate identity while labels or secrets do not become route identity',()=>{
  const listeners=new Map();let reads=0;
  const endpoint=new URL('https://qa.invalid/v1?secret=do-not-retain');endpoint.username='user';endpoint.password='password';
  let profile={baseURL:endpoint.href,api:'openai-completions',displayName:'测试连接',apiKeyEnv:'QA_ONLY_KEY'};
  const ctx={on:(name,listener)=>listeners.set(name,listener),llm:{listConfigurableProviders:()=>[{provider:'qa',settingsNs:'qa-settings',settingsPath:['providers','qa']}]},
    get:()=>({describe(options){assert.equal(options.redactSecrets,true);reads++;return [{ns:'qa-settings',value:{providers:{qa:profile}}}];}})};
  const resolve=createChatConnectionResolver(ctx),route={provider:'qa',model:'model-a'};
  const one=resolve(route);assert.ok(one.connection.includes('qa.invalid/v1'));assert.equal(/password|secret|QA_ONLY_KEY/.test(JSON.stringify(one)),false);
  resolve(route);assert.equal(reads,1);
  profile={...profile,displayName:'改名'};listeners.get('settings/document-updated')();assert.deepEqual(resolve(route),one);
  profile={...profile,baseURL:'https://qa.invalid/v2'};listeners.get('loader/volatile-update')();assert.notEqual(resolve(route).connection,one.connection);
  assert.deepEqual(resolve({provider:'unknown',model:'other'}),{connection:null,coverage:'provider-model-only'});
});
