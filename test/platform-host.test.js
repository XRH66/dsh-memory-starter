import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {apply} from '../lib/platform-host.js';
import {apply as applyBundle,Config as BundleConfig} from '../lib/bundle-entry.js';
import {createPersonaRenderer} from '../lib/persona-source.js';
import {scratchDirectory} from './helpers.js';

test('explicit persona reads the selected vault and refuses outside profiles',async()=>{
 const root=await scratchDirectory('persona-source-'),vault=path.join(root,'vault'),base=path.join(root,'persona.md'),self=path.join(vault,'self.md'),outside=path.join(root,'outside.md');await fs.mkdir(vault);await fs.writeFile(base,'基础人设');await fs.writeFile(self,'---\ntitle: test\n---\n<!-- dafeiyu-record kind=thoughts -->\n成长经历');await fs.writeFile(outside,'<!-- dafeiyu-record kind=thoughts -->\n外部档案');
 const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self});assert.match(render(),/基础人设[\s\S]*成长经历/);assert.throws(()=>createPersonaRenderer({directory:root,selfProfile:outside})(),/inside the selected personal vault/);
 await fs.writeFile(self,'无标记档案');assert.throws(()=>render(),/owned thoughts record/);
});

test('bundle rejects removed and unknown modes and only serves setup until configured',async()=>{
 const registered=new Map(),ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},agents:{},llm:{},logger:{},on(){}};
 assert.throws(()=>applyBundle(ctx,{mode:'typo'}),/Unknown memory runtime mode/);
 const parsed=BundleConfig({mode:'portable',personal:{directory:'fixture'}});assert.equal(parsed.mode,'portable');assert.equal(parsed.personal.directory,'fixture');
 for(const mode of ['legacy','unified'])assert.throws(()=>applyBundle(ctx,{mode}),new RegExp('已不支持 '+mode+' 模式'));
 assert.throws(()=>applyBundle(ctx,{mode:'portable',sessionMemory:false}),/不再支持不用对话开关的运行方式/);
 assert.equal(applyBundle(ctx,{}),undefined);assert.equal(registered.size,0);
});

test('personal host refuses implicit directories and transport session IDs',async()=>{
 const ctx={};
 await assert.rejects(apply(ctx,{directory:'relative',sessionIds:[]}),/explicit/);
 await assert.rejects(apply(ctx,{directory:path.resolve('.local'),sessionIds:['not-a-session']}),/explicit/);
});
