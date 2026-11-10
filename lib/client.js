window.__ModuleLoader__.load({
  id:'@local/dsh-basic-memory-bridge',
  factory:(require)=>{
    const React=require('react'),h=React.createElement, exports={};
    const css=`
.memory-page{max-width:960px;padding:24px;color:var(--dsw-alias-label-primary,CanvasText);font:inherit}
.memory-page h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.memory-page .summary,.memory-page .note{color:var(--dsw-alias-label-secondary,GrayText);font-size:13px;line-height:1.6}
.memory-page .summary{margin:5px 0 20px}.memory-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l2,ButtonBorder)}
.memory-tabs button{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer;font:inherit;padding:10px 12px;white-space:nowrap}
.memory-tabs button[aria-selected=true]{border-bottom-color:var(--dsw-alias-label-primary,CanvasText);color:var(--dsw-alias-label-primary,CanvasText);font-weight:600}
.memory-tabs button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:-2px}
.memory-content{padding:22px 0}.memory-content h3{font-size:14px;margin:0 0 8px}.memory-line{display:flex;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2,ButtonBorder);font-size:13px}
.memory-line span:first-child{flex:0 0 144px}.memory-line span:last-child{color:var(--dsw-alias-label-secondary,GrayText);min-width:0;overflow-wrap:anywhere;text-align:right}.memory-page .note{margin-top:14px}
.memory-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.memory-actions button{background:var(--dsw-alias-bg-layer-2,ButtonFace);border:1px solid var(--dsw-alias-border-l2,ButtonBorder);border-radius:6px;color:inherit;cursor:pointer;font:inherit;font-size:13px;padding:7px 12px}.memory-actions button:disabled{opacity:.55;cursor:default}.memory-actions button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:2px}.memory-notice{font-size:13px;line-height:1.6;margin-top:12px}
.memory-sessions{border:0;margin:24px 0 0;padding:0}.memory-sessions legend{font-size:14px;font-weight:600;margin-bottom:8px}.memory-session-list{max-height:240px;overflow-y:auto;border-block:1px solid var(--dsw-alias-border-l2,ButtonBorder)}.memory-session{align-items:flex-start;display:flex;font-size:13px;gap:10px;line-height:1.5;padding:10px 2px}.memory-session span{overflow-wrap:anywhere}.memory-session small{color:var(--dsw-alias-label-secondary,GrayText);display:block}.memory-session input{margin-top:3px}
.memory-session-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.memory-session-row .memory-session{flex:1;min-width:0}.memory-session-row .memory-actions{margin:0;flex-shrink:0}.memory-session-toggle{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px}.memory-session-toggle button{background:transparent;border:1px solid var(--dsw-alias-border-l2,ButtonBorder);border-radius:6px;color:inherit;cursor:pointer;font:inherit;padding:5px 9px}.memory-session-toggle button:disabled{cursor:default;opacity:.55}.memory-session-toggle button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:2px}.memory-session-toggle small{color:var(--dsw-alias-label-secondary,GrayText)}
.memory-group-form{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.memory-group-form input{background:var(--dsw-alias-bg-layer-1,Field);border:1px solid var(--dsw-alias-border-l2,ButtonBorder);border-radius:6px;color:inherit;font:inherit;font-size:13px;min-width:0;padding:7px 9px}.memory-group-form label{display:flex;flex:1 1 150px;flex-direction:column;font-size:12px;gap:5px}.memory-group-list{max-height:240px;overflow-y:auto}.memory-group-row{align-items:center;display:flex;gap:10px;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2,ButtonBorder);font-size:13px}.memory-group-row small{color:var(--dsw-alias-label-secondary,GrayText);display:block}
.memory-group-options{border-bottom:1px solid var(--dsw-alias-border-l2,ButtonBorder);font-size:13px;padding:8px 0 14px}.memory-group-options summary{cursor:pointer}.memory-policy{border:0;margin:12px 0 0;padding:0}.memory-policy legend{font-weight:600}.memory-policy label{display:block;line-height:1.5;padding:5px 0}.memory-policy input{margin-right:7px}.memory-policy .note{margin:6px 0}
.memory-model{margin-top:24px}.memory-model select{background:var(--dsw-alias-bg-layer-1,Field);border:1px solid var(--dsw-alias-border-l2,ButtonBorder);border-radius:6px;color:inherit;font:inherit;font-size:13px;max-width:100%;padding:7px 9px}.memory-model details{margin-top:12px}.memory-model summary{cursor:pointer;font-size:13px}
@media(max-width:520px){.memory-page{padding:16px}.memory-tabs button{padding:10px 8px}}
`;
    function style(){const el=document.createElement('style');el.textContent=css;document.head.appendChild(el);return()=>el.remove();}
    const sessionSettingsPath='/api/basic-memory-settings/sessions',sessionsChanged='basic-memory:sessions-changed';
    const hasSessionMemory=info=>info?.sessionMemory?.defaultEnabled===false&&info.sessionMemory.effective==='next-user-turn'&&Array.isArray(info.sessionMemory.enabledSessions);
    // Old bindings are not a new authorization. Only the portable opt-in receipt counts.
    const enabledSessionIds=info=>hasSessionMemory(info)?info.sessionMemory.enabledSessions:[];
    const sessionState=(info,id)=>info?.sessionMemory?.states?.find(item=>item.sessionId===id);
    function sessionStateText(info,id){
      if(!hasSessionMemory(info))return '对话记忆开关尚未接通';
      const state=sessionState(info,id),requested=enabledSessionIds(info).includes(id);
      if(info.runtime!=='loaded')return (requested?'已保存开启':'已保存关闭')+'；等待记忆框架加载';
      if(state?.pending)return requested?'已保存开启，下一新回合生效':'已保存关闭，等待状态同步';
      if(!requested)return '已关闭：不读不记';
      return state?.active===true?'已开启：本回合允许使用记忆':'已开启，下一新回合生效';
    }
    async function sessionSettings(change,revision){
      const response=await fetch(sessionSettingsPath,{credentials:'same-origin',cache:'no-store',...(change?{method:'POST',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({...change,revision})}:{})});
      const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||(change?'保存失败':'无法读取对话记忆状态'));return value;
    }
    function ConversationMemory({sessionId}){
      const [info,setInfo]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
      const current=React.useRef(sessionId),request=React.useRef(0),saving=React.useRef(false);current.current=sessionId;
      const load=React.useCallback(async()=>{
        if(!sessionId||saving.current)return;
        const ticket=++request.current;
        try{const value=await sessionSettings();if(current.current===sessionId&&request.current===ticket){setInfo(value);setError('');}}
        catch(err){if(current.current===sessionId&&request.current===ticket)setError(err.message||'无法读取对话记忆状态');}
      },[sessionId]);
      React.useEffect(()=>{setInfo(null);setError('');setBusy(false);saving.current=false;load();return()=>{request.current++;};},[load]);
      React.useEffect(()=>{window.addEventListener('focus',load);window.addEventListener(sessionsChanged,load);return()=>{window.removeEventListener('focus',load);window.removeEventListener(sessionsChanged,load);};},[load]);
      React.useEffect(()=>{if(!sessionState(info,sessionId)?.pending)return;const timer=setInterval(load,1500);return()=>clearInterval(timer);},[sessionState(info,sessionId)?.pending,load]);
      const requested=enabledSessionIds(info).includes(sessionId);
      async function toggle(){
        if(busy||saving.current||!hasSessionMemory(info))return;
        const target=sessionId,ticket=++request.current;saving.current=true;setBusy(true);setError('');
        try{
          const value=await sessionSettings({action:requested?'unbind':'bind',value:target},info.revision);
          if(current.current===target&&request.current===ticket)setInfo(value);
          window.dispatchEvent(new Event(sessionsChanged));
        }catch(err){
          if(current.current===target&&request.current===ticket){
            // A stale revision may have been changed elsewhere. Re-read without retrying the write.
            try{const value=await sessionSettings();if(current.current===target&&request.current===ticket)setInfo(value);}catch{}
            if(current.current===target&&request.current===ticket)setError(err.message||'保存失败');
          }
        }finally{if(current.current===target&&request.current===ticket){saving.current=false;setBusy(false);}}
      }
      const label=requested?'关闭本对话记忆':'启用本对话记忆';
      return h('span',{className:'memory-session-toggle'},
        h('button',{type:'button',disabled:!sessionId||busy||(!info&&!error)||Boolean(info&&!hasSessionMemory(info)),onClick:info&&hasSessionMemory(info)?toggle:load,'aria-pressed':info&&hasSessionMemory(info)?requested:undefined,title:'所有对话默认不读不记。开启从下一新回合生效；重新开启不补记关闭期间的内容。'},busy?'保存中…':!info&&error?'重试记忆状态':label),
        h('small',{role:'status','aria-live':'polite'},error||(!sessionId?'请先打开一个对话':!info?'正在读取记忆状态':sessionStateText(info,sessionId))));
    }
    function ModelPreparation({info,draft,onPrepared,onDownloaded,onRunning,simple=false,installed=null,downloadBytes=0}){
      const [plan,setPlan]=React.useState(null),[job,setJob]=React.useState(null),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[acceleration,setAcceleration]=React.useState(draft.rawRecallDevice==='cpu'?'cpu':/Embedding-(?:4B|8B)$/.test(draft.rawRecallModel)?'cuda':'cpu');
      const draftRef=React.useRef(draft),downloadedRef=React.useRef('');draftRef.current=draft;
      React.useEffect(()=>{onRunning(job?.state==='running');return()=>onRunning(false);},[job?.state,onRunning]);
      const refresh=async()=>{const response=await fetch('/api/basic-memory-settings/sessions',{credentials:'same-origin'}),value=await response.json();if(response.ok&&value.ok)onPrepared(value);};
      const request=async input=>{const response=await fetch('/api/basic-memory-settings/model-install',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,settings:draftRef.current,acceleration,...input})});const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error || '准备未完成');return value;};
      React.useEffect(()=>{setPlan(null);setNotice('');},[draft.rawRecallModel,acceleration]);
      React.useEffect(()=>{if(job?.state!=='running')setAcceleration(draft.rawRecallDevice==='cpu'?'cpu':/Embedding-(?:4B|8B)$/.test(draft.rawRecallModel)?'cuda':'cpu');},[draft.rawRecallModel,draft.rawRecallDevice]);
      React.useEffect(()=>{
        let stopped=false,timer;
        const poll=async()=>{
          try{const response=await fetch('/api/basic-memory-settings/model-install',{credentials:'same-origin'}),value=await response.json();
            if(stopped)return;
            if(response.ok&&value.ok){
              setJob(value.job);
              if(value.job?.state==='running')timer=setTimeout(poll,1000);
              else if(value.job?.state==='prepared')await refresh();
              else if(value.job?.state==='downloaded'&&downloadedRef.current!==value.job.id){
                downloadedRef.current=value.job.id;await onDownloaded?.(value.job.model);
              }
            }
          }catch{if(!stopped)setNotice('暂时无法读取准备进度，可刷新页面继续查看');}
        };
        poll();return()=>{stopped=true;clearTimeout(timer);};
      },[job?.id,job?.state==='running']);
      const act=async action=>{
        setBusy(true);setNotice('');try{
          const value=await request(action);if(value.plan)setPlan(value.plan);if(value.job)setJob(value.job);
          if(action.action==='start')setNotice(action.downloadOnly?'已开始下载，可取消。下载完成后选中并保存才会启用。':'已开始准备；下载可取消，完成后保存为待切换。');
        }catch(error){setNotice(error.message);}finally{setBusy(false);}
      };
      const running=job?.state==='running',gguf=/Embedding-(?:4B|8B)$/.test(draft.rawRecallModel);
      const size=bytes=>(bytes/1024/1024).toFixed(bytes>1024**3?0:1)+' MB';
      // Simple view (model tab): download files only, then enable through the normal save flow.
      if(simple)return h('div',null,
        installed===false&&!running&&h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>act({action:'start',allowDownload:true,downloadOnly:true})},'下载')),
        installed===false&&!running&&h('p',{className:'note'},'该模型尚未下载（约 '+size(downloadBytes)+'）。下载只保存文件，不会切换模型。'),
        job&&(running||job.model===draft.rawRecallModel)&&h('p',{className:'memory-notice',role:'status'},job.step+(running&&job.total?'（'+size(job.received)+' / '+size(job.total)+'）':'')+(job.error?'；'+job.error:'')),
        running&&h('button',{type:'button',disabled:busy,onClick:()=>act({action:'cancel',id:job.id})},'取消'),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
      return h('div',null,
        gguf&&h('label',null,'下载的运行包 ',h('select',{value:acceleration,disabled:running,onChange:event=>setAcceleration(event.target.value)},h('option',{value:'cpu'},'CPU（通用）'),h('option',{value:'cuda'},'NVIDIA 显卡（CUDA 12.4，需兼容驱动）'))),
        h('div',{className:'memory-actions'},
          h('button',{type:'button',disabled:busy||running,onClick:()=>act({action:'plan'})},'查看安装与资源建议'),
          h('button',{type:'button',disabled:busy||running,onClick:()=>act({action:'plan',readGpu:true})},'读取可用显存')),
        plan&&h('div',{className:'note'},
          h('p',null,'所选模型及运行包约 '+size(plan.downloadBytes)+'；Python 依赖另计。已有正确文件会复用。'),
          h('p',null,'当前可用内存约 '+plan.resources.freeRamGiB.toFixed(1)+' GB，建议 CPU 线程 '+plan.resources.suggestedThreads+'；资源建议型号：'+plan.resources.recommendedModel+'。'),
          plan.resources.gpuState==='available'&&h('p',null,...plan.resources.gpus.map(gpu=>gpu.name+' 可用显存约 '+gpu.freeGiB.toFixed(1)+' GB；')),
          plan.resources.gpuState==='unavailable'&&h('p',null,'没有读到 NVIDIA 显存信息；仍可选择 CPU，或手动配置其他兼容运行程序。'),
          h('p',null,plan.resources.recommendationBasis),
          h('p',null,'已有正确模型文件可复用。文件准备、运行加载和索引就绪分别显示。'),
          h('p',null,plan.origin),
          h('a',{href:plan.source,target:'_blank',rel:'noreferrer'},'查看模型来源'),
          h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||running,onClick:()=>act({action:'start',allowDownload:true})},'下载准备并保存选择'),
            h('button',{type:'button',disabled:busy||running,onClick:()=>act({action:'start',useExisting:true})},'使用高级设置中的已有文件'))),
        job&&h('p',{className:'memory-notice',role:'status'},job.model+'：'+job.step+(running&&job.total?'（当前文件 '+size(job.received)+' / '+size(job.total)+'）':'')+(job.error?'；'+job.error:'')),
        running&&h('button',{type:'button',disabled:busy,onClick:()=>act({action:'cancel',id:job.id})},'取消准备（保留已下载部分）'),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    const runtimePath='/api/basic-memory-settings/runtime';
    async function memoryRuntime(input){
      const response=await fetch(runtimePath,{credentials:'same-origin',cache:'no-store',...(input?{method:'POST',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify(input)}:{})});
      const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'无法读取记忆运行状态');return value;
    }
    // Preparation never waits for a chat query; say so instead of a raw code.
    const errorLabel=code=>code==='EMBEDDING_BUSY'?'对话查询正在使用向量模型，请等这次对话结束后再点击':code;
    const deviceLabel=value=>({auto:'自动（优先 GPU）',cpu:'CPU',cuda:'GPU（NVIDIA CUDA）'})[value]??'未报告';
    const runtimeStateLabel=value=>({loaded:'已加载',loading:'加载中',unloaded:'未加载',releasing:'释放中',released:'已释放',unavailable:'不可用',error:'失败',failed:'失败',ready:'已就绪',preparing:'准备中',paused:'已暂停',unprepared:'未准备',pending:'等待中',held:'已持有',running:'进行中',completed:'已返回',cancelled:'已取消',idle:'空闲'})[value]??value??'未知';
    const operationLabel=value=>({load:'加载模型',release:'释放模型',prepare:'准备索引','resume-prepare':'续建索引',cancel:'取消向量操作',resume:'恢复后台任务',flush:'尝试整理待办',retry:'重试批次','legacy-recover':'恢复旧任务'})[value]??value??'无';
    function MemoryRuntimeSettings({info,modelId,cloud=false,dirty=false,showVectors=true}){
      const [state,setState]=React.useState(()=>info?.memoryRuntime??(info?.runtime&&typeof info.runtime==='object'?info.runtime:null)),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[batchId,setBatchId]=React.useState('');
      const [legacyId,setLegacyId]=React.useState('');
      const alive=React.useRef(false),request=React.useRef(0),acting=React.useRef(false);
      const refresh=React.useCallback(async()=>{
        const ticket=++request.current;
        try{const value=await memoryRuntime();if(alive.current&&ticket===request.current){setState(value);setError('');}}
        catch(cause){if(alive.current&&ticket===request.current){setError(cause.message);setState(null);}}
      },[]);
      React.useEffect(()=>{alive.current=true;refresh();return()=>{alive.current=false;request.current++;};},[refresh,info?.revision]);
      React.useEffect(()=>{if(state?.operation?.state!=='running')return;const timer=setInterval(refresh,1500);return()=>clearInterval(timer);},[state?.operation?.state,refresh]);
      const vectors=state?.vectors,pipeline=state?.pipeline;
      const profiles=Array.isArray(vectors?.profiles)?vectors.profiles:[];
      const profile=profiles.find(row=>row.id===modelId||row.model===modelId);
      const target=profile?.id??modelId;
      // Accept the host's backend-status object and the existing profiles.status
      // string + top-level device fields. Neither is inferred from a draft.
      const runtime=profile?(typeof profile.modelState==='object'&&profile.modelState!==null?profile.modelState:profile):
        vectors?.runtime&&(vectors.runtime.profileId===target||vectors.runtime.requestedModel===modelId||!vectors.runtime.profileId&&!vectors.runtime.requestedModel&&vectors.activeProfileId===target)?vectors.runtime:null;
      const actualDevice=runtime&&Object.hasOwn(runtime,'actualDevice')?runtime.actualDevice:runtime?.runtime?.device??runtime?.device;
      const fallbackReason=runtime?.fallbackReason;
      const modelState=runtime?.releasing?'releasing':runtime?.preparing?'loading':runtime?.prepared===true?'loaded':runtime?.prepared===false?'unloaded':typeof profile?.modelState==='string'?profile.modelState==='loaded'&&!cloud&&runtime?.actualDevice===null?'unloaded':profile.modelState:runtime?.modelState;
      const progress=profile?.progress;
      const operation=state?.operation,operating=operation?.state==='running';
      const batches=Array.isArray(pipeline?.batches)?pipeline.batches.filter(row=>['held','error'].includes(row.state)):[];
      const priority=pipeline?.latestPriority;
      const count=value=>Number.isFinite(value)?value:'未知';
      async function act(action){
        if(acting.current)return;acting.current=true;setBusy(true);setError('');setNotice('');request.current++;
        const vectorAction=['load','release','prepare','resume-prepare','cancel'].includes(action);
        const actionProfile=action==='cancel'&&operating&&operation.profileId
          ?{id:operation.profileId,revision:operation.profileRevision}:{id:target,revision:profile?.revision};
        const input={action,...(vectorAction?{profileId:actionProfile.id,...(actionProfile.revision!==undefined?{profileRevision:actionProfile.revision}:{})}:action==='retry'?{batchId}:action==='legacy-recover'?{sessionId:legacyId}:{})};
        if(action==='resume-prepare')input.intentId=progress.intentId;
        try{
          const result=await memoryRuntime(input);
          if(alive.current)setNotice(result.started?'操作已启动；将刷新状态查看实际进度。':action==='cancel'?'取消请求已返回；以下以实际运行回执为准。':'操作请求已返回；以下以实际运行回执为准。');
          if(alive.current)await refresh();
        }catch(cause){if(alive.current){setError(cause.message);await refresh();setError(cause.message);}}
        finally{acting.current=false;if(alive.current)setBusy(false);}
      }
      const modelBusy=['loading','releasing'].includes(modelState)||progress?.state==='preparing';
      return h('fieldset',{className:'memory-policy memory-model'},h('legend',null,showVectors?'运行资源与后台调度':'后台调度'),
        showVectors&&h(React.Fragment,null,
          h('p',{className:'note'},vectors?.activeProfileId?'统一向量服务已接入；当前生效档位：'+vectors.activeProfileId+'。':vectors?'统一向量服务已接入，尚无生效档位。':'统一向量状态尚未接入；不能据此确认各记忆域已统一。'),
          vectors?.selectedProfileId&&vectors.selectedProfileId!==vectors.activeProfileId&&h('p',{className:'note'},'待准备档位：'+vectors.selectedProfileId),
          h('p',{className:'note'},'正在查看：'+modelId+'；运行状态：'+runtimeStateLabel(modelState)+'。加载与索引就绪分别计算。'),
          !cloud&&h('p',{className:'note'},'实际运行设备：'+(actualDevice?deviceLabel(actualDevice):modelState==='unloaded'||modelState==='released'?'未加载':'未报告')+(fallbackReason?'；回退原因：'+fallbackReason:'')),
          !cloud&&Number.isFinite(runtime?.idleReleaseMs)&&h('p',{className:'note'},'实际空闲释放设置：'+(runtime.idleReleaseMs===0?'常驻':runtime.idleReleaseMs/1000+' 秒')+(runtime?.runtime?.threads!==undefined?'；计算线程 '+runtime.runtime.threads:'')),
          profile?.modelError&&h('p',{className:'memory-notice',role:'status'},'模型错误：'+(profile.modelError.message??profile.modelError.code??String(profile.modelError))),
          h('p',{className:'note'},'全域索引：'+(progress?.pendingBoundaries?'待追平（上次完成 '+count(progress?.completed)+' / '+count(progress?.total)+'）':runtimeStateLabel(progress?.state)+'（'+count(progress?.completed)+' / '+count(progress?.total)+'）')+(progress?.error?'；'+errorLabel(progress.error):'')),
          profile?.embeddingUsage&&h('p',{className:'note'},'向量请求 '+count(profile.embeddingUsage.calls)+' 次；已报告 '+count(profile.embeddingUsage.reportedTokens)+' tokens；未知用量 '+count(profile.embeddingUsage.unknownUsageCalls)+' 次。'),
          info?.rawRecall?.stats&&!vectors&&h('p',{className:'note'},'旧原话索引回执：'+count(info.rawRecall.stats.indexedWindows)+' / '+count(info.rawRecall.stats.eligibleWindows)+' 个片段；不代表全域索引。'),
          h('div',{className:'memory-actions'},
            !cloud&&h('button',{type:'button',disabled:busy||operating||dirty||!profile||modelBusy,onClick:()=>act('load')},'加载／预热'),
            !cloud&&h('button',{type:'button',disabled:busy||operating||dirty||!profile||modelBusy,onClick:()=>act('release')},'释放运行资源'),
            h('button',{type:'button',disabled:busy||operating||dirty||!profile||modelBusy,onClick:()=>act('prepare')},'准备索引'),
            progress?.intentId&&['preparing','paused','error'].includes(progress.state)&&h('button',{type:'button',disabled:busy||operating||dirty,onClick:()=>act('resume-prepare')},'续建原索引')),
          dirty&&h('p',{className:'note'},'查看目标或运行设置尚未保存；保存后再加载或准备索引。')),
        h('p',{className:'note'},pipeline?'长期整理：'+(pipeline.enabled===false?'未启用':pipeline.busy?'处理中':'等待调度')+'；待处理 '+count(pipeline.pending)+'，运行中 '+count(pipeline.running)+'，持有 '+count(pipeline.held)+'，已完成 '+count(pipeline.completed)+'。':'后台整理尚未接入。'),
        !showVectors&&priority&&h('p',{className:'note'},'最近优先整理：'+({remember:'记住',correction:'更正',decision:'决定'}[priority.kind]??'用户请求')+' · '+
          (priority.state==='committed'?'整理完成，已应用 '+count(priority.applied)+' 项，送审 '+count(priority.reviews)+' 项':runtimeStateLabel(priority.state))),
        pipeline?.waitingReason&&h('p',{className:'note'},'等待原因：'+pipeline.waitingReason),
        pipeline?.deliveryPending!==undefined&&h('p',{className:'note'},'已整理待投递：'+count(pipeline.deliveryPending)),
        h('div',{className:'memory-actions'},
          h('button',{type:'button',disabled:busy,onClick:refresh},'刷新运行状态'),
          (showVectors&&(modelState==='loading'||progress?.state==='preparing')||operating&&['load','prepare','resume-prepare'].includes(operation.action))&&h('button',{type:'button',disabled:busy,onClick:()=>act('cancel')},'取消向量操作'),
          h('button',{type:'button',disabled:busy||operating||!pipeline||pipeline.enabled===false,onClick:()=>act('resume')},'恢复后台任务'),
          h('button',{type:'button',disabled:busy||operating||!pipeline||pipeline.enabled===false,onClick:()=>act('flush')},'尝试整理待办')),
        pipeline&&h('p',{className:'note'},'后台操作仍检查原始授权及前台占用；提交操作不等于已完成整理。'),
        !showVectors&&state?.legacy?.length>0&&h('details',null,h('summary',null,'旧任务接续'),
          h('label',null,'旧任务原会话 ',h('select',{value:legacyId,disabled:busy||operating,onChange:event=>setLegacyId(event.target.value)},
            h('option',{value:''},'选择原会话'),...state.legacy.map(row=>h('option',{key:row.sessionId,value:row.sessionId},
              `${info?.sessions?.find(session=>session.id===row.sessionId)?.title??row.sessionId} · 整理 ${row.capture} · 同步 ${row.maintenance}`)))),
          h('button',{type:'button',disabled:busy||operating||!state.legacy.some(row=>row.sessionId===legacyId),onClick:()=>act('legacy-recover')},'恢复所选会话的旧任务')),
        !showVectors&&operation?.receipt&&h('p',{role:'status'},`旧任务已恢复 ${operation.receipt.resumed.length} 项，持有 ${operation.receipt.held.length} 项。${[...new Set(operation.receipt.held.map(item=>item.reason))].join('、')}`),
        batches.length>0&&h('details',null,h('summary',null,'持有与失败批次'),h('label',null,'重试批次 ',h('select',{'aria-label':'重试批次',value:batchId,disabled:busy||operating,onChange:event=>setBatchId(event.target.value)},h('option',{value:''},'选择批次'),...batches.map(row=>h('option',{key:row.id,value:row.id},row.id+' · '+runtimeStateLabel(row.state)+(row.error?' · '+row.error:''))))),h('button',{type:'button',disabled:busy||operating||!batches.some(row=>row.id===batchId),onClick:()=>act('retry')},'重试所选批次')),
        operation&&h('p',{className:'note',role:'status'},'操作回执：'+operationLabel(operation.action)+' · '+runtimeStateLabel(operation.state)+(operation.error?'；'+errorLabel(operation.error):'')+'。后台待办是否完成见上方计数。'),
        busy&&h('p',{className:'note',role:'status'},'正在提交操作…'),
        notice&&h('p',{className:'memory-notice',role:'status'},notice),error&&h('p',{className:'memory-notice',role:'alert'},error));
    }
    // One confirmation: estimate (read-only plan) -> confirm -> save or switch;
    // preparation then starts by itself and activates only when complete.
    function ModelSwitch({info,modelId,draft,dirty,cloud,onStage}){
      const [state,setState]=React.useState(null),[plan,setPlan]=React.useState(null),[confirming,setConfirming]=React.useState(''),[cloudOk,setCloudOk]=React.useState(false),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      const load=React.useCallback(async()=>{try{
        const value=await memoryRuntime(),found=value.vectors?.profiles?.find(row=>row.id===modelId||row.model===modelId);setState(value);
        setPlan(found?(await memoryRuntime({action:'plan',profileId:found.id})).plan:null);
      }catch(cause){setNotice(cause.message);}},[modelId,info?.revision]);
      React.useEffect(()=>{setConfirming('');setCloudOk(false);load();},[load]);
      React.useEffect(()=>{if(state?.operation?.state!=='running')return;const timer=setInterval(load,2000);return()=>clearInterval(timer);},[state?.operation?.state,load]);
      const vectors=state?.vectors;if(!vectors)return notice?h('p',{className:'memory-notice',role:'status'},notice):null;
      const profile=vectors.profiles?.find(row=>row.id===modelId||row.model===modelId),progress=profile?.progress,intent=vectors.switchIntent;
      const mine=Boolean(profile&&intent?.profileId===profile.id),active=Boolean(profile&&vectors.activeProfileId===profile.id&&vectors.active?.revision===profile.revision);
      const needsReload=dirty||!profile||info.rawModel?.fields?.rawRecallModel!==modelId;
      const pendingText=plan?.pending>0?'需补 '+plan.pending+' 篇':'';
      const status=mine&&progress?.state==='preparing'?'切换中 '+(progress.completed??0)+' / '+(progress.total??'?')+'。期间向量检索暂不可用，文字与条目检索正常'
        :mine&&['paused','cancelled'].includes(progress?.state)?'已暂停，下次启动自动续建'
        :mine&&progress?.state==='error'?'出错：'+(errorLabel(progress.error)??'未知原因')
        :active?'使用中'+(pendingText?'，'+pendingText:'')
        :profile?.index?.hasSnapshot?(pendingText?'可切回，'+pendingText:'可立即切回')
        :'未建索引'+(plan?'，需编码 '+plan.pending+' 篇':'');
      const run=async(work,done)=>{setBusy(true);setNotice('');try{await work();setConfirming('');setNotice(done);await load();}catch(cause){setNotice(cause.message);}finally{setBusy(false);}};
      const doSwitch=()=>run(async()=>{
        if(needsReload)await onStage({confirmSwitch:true,cloudConfirmed:cloud&&cloudOk});
        else await memoryRuntime({action:'switch',profileId:profile.id,cloudConfirmed:cloud&&cloudOk});
      },needsReload?'选择已保存；重新加载记忆框架后自动开始准备，完成后再切换。':'已开始准备；完成后自动切换到此模型。');
      const wan=chars=>Number.isFinite(chars)?(chars/10000).toFixed(chars<10000?2:1):'未知';
      return h('div',{className:'note','aria-label':'切换向量模型'},
        h('p',{role:'status'},'此模型：'+status+'。'),
        h('div',{className:'memory-actions'},
          !active&&!mine&&h('button',{type:'button',disabled:busy||Boolean(confirming)||cloud&&!draft.rawRecallAllowCloud,onClick:()=>setConfirming('switch')},'切换到此模型'),
          mine&&progress?.state==='error'&&h('button',{type:'button',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'switch',profileId:profile.id,cloudConfirmed:intent.cloudConfirmed===true}),'已重新开始准备。')},'重试'),
          mine&&h('button',{type:'button',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'cancel-switch'}),'已取消切换；当前模型不变。')},'取消切换'),
          profile?.index?.hasSnapshot&&!active&&!mine&&progress?.state!=='preparing'&&h('button',{type:'button',disabled:busy||Boolean(confirming),onClick:()=>setConfirming('drop')},'清理此模型的索引')),
        confirming==='switch'&&h('div',{role:'dialog','aria-label':'确认切换'},
          h('p',null,(plan?'共 '+plan.total+' 篇，其中 '+plan.reusable+' 篇可直接复用，需编码 '+plan.pending+' 篇（约 '+wan(plan.pendingChars)+' 万字）。':'需编码的篇数在重新加载后统计（已有索引的部分会直接复用）。')+'期间向量检索暂不可用，文字与条目检索不受影响。'),
          cloud&&h('p',null,'将把这 '+(plan?plan.pending:'全部待编码')+' 篇（约 '+(plan?.estimatedTokens??'未知')+' token，估算）发送到 '+(draft.rawRecallApiBase||'所设 API 地址')+'，按服务商价格计费。'),
          cloud&&h('label',null,h('input',{type:'checkbox',checked:cloudOk,onChange:event=>setCloudOk(event.target.checked)}),'我确认本次发送范围'),
          needsReload&&h('p',null,'确认后保存选择；重新加载记忆框架后自动开始准备，全部完成后才切换。'),
          h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||cloud&&!cloudOk,onClick:doSwitch},'确认切换'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirming('')},'返回'))),
        confirming==='drop'&&h('div',{role:'dialog','aria-label':'确认清理索引'},
          h('p',null,'将删除此模型已建好的索引，不影响原话、条目和当前使用的模型。下次切回需全量重建。'),
          h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'drop-index',profileId:profile.id}),'已清理此模型的索引。')},'确认清理'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirming('')},'返回'))),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function RawModelSettings({info,onSaved}){
      const [reuseApiKey,setReuseApiKey]=React.useState(false);
      const [draft,setDraft]=React.useState(null),[key,setKey]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[rollbackCloud,setRollbackCloud]=React.useState(false),[preparing,setPreparing]=React.useState(false),[expert,setExpert]=React.useState(false),[confirmRestore,setConfirmRestore]=React.useState(false);
      const withDefaults=fields=>fields?{rawRecallDevice:'auto',rawRecallCpuThreads:6,rawRecallGpuThreads:4,rawRecallLlamaCpuServer:'',rawRecallLlamaCudaServer:'',rawRecallIdleMs:0,rawRecallQueryWaitMs:0,...fields}:null;
      React.useEffect(()=>{setDraft(withDefaults((info.pendingRawModel??info.rawModel)?.fields));setKey('');setReuseApiKey(false);},[info.revision]);
      if(!draft||!info.rawModels)return null;
      const selected=info.rawModels.find(model=>model.id===draft.rawRecallModel),cloud=Boolean(selected?.cloud);
      const previous=withDefaults((info.pendingRawModel??info.rawModel).fields);
      const dirty=JSON.stringify(previous)!==JSON.stringify(draft)||Boolean(key.trim())||reuseApiKey;
      const update=(name,value)=>{if(name==='rawRecallApiBase')setReuseApiKey(false);setDraft(current=>({...current,[name]:value,
        ...['rawRecallPython','rawRecallCacheDir','rawRecallBgeModelDir','rawRecallOnnxModel','rawRecallOnnxTokenizer','rawRecallGgufModel','rawRecallLlamaServer','rawRecallLlamaCpuServer','rawRecallLlamaCudaServer'].includes(name)?{rawRecallInstallReceipt:''}:{}}));};
      const changeModel=value=>{const next=info.rawModels.find(model=>model.id===value);setDraft(current=>({...current,rawRecallModel:value,rawRecallDimensions:0,rawRecallTimeoutMs:next?.engine==='llamacpp'?10000:3000,rawRecallAllowCloud:false,rawRecallInstallReceipt:'',...(next?.engine!=='llamacpp'?{rawRecallDevice:'cpu'}:{}),...(next?.engine==='llamacpp'&&value!==current.rawRecallModel?{rawRecallGgufModel:'',rawRecallDevice:'auto'}:{})}));setNotice('');};
      const save=async(cancel=false,extra={})=>{setBusy(true);setNotice('');try{
        const response=await fetch('/api/basic-memory-settings/model',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,...(cancel?{cancel:true}:{settings:draft,...(key.trim()?{apiKey:key.trim()}:{reuseApiKey}),...extra})})});
        const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');onSaved(value);setKey('');setNotice(cancel?'已取消待切换的模型。':extra.confirmSwitch?'已确认切换；重新加载后自动准备索引。':'设置已保存；以待生效提示和实际运行状态为准，保存不会启动模型。');
      }catch(error){setNotice(error.message||'保存失败');if(extra.confirmSwitch)throw error;}finally{setBusy(false);}};
      const field=(name,label,type='text')=>h('label',{key:name},label,h('input',{type,disabled:preparing,value:draft[name]??'',onChange:event=>update(name,type==='number'?Number(event.target.value):event.target.value)}));
      const restore=async()=>{const previous=info.rawModelHistory?.[0];if(!previous)return;setBusy(true);setNotice('');try{
        const response=await fetch('/api/basic-memory-settings/model',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,restoreId:previous.id,allowCloud:rollbackCloud,confirmSwitch:true,cloudConfirmed:rollbackCloud})}),value=await response.json();
        if(!response.ok||!value.ok)throw Error(value.error || '恢复未完成');onSaved(value);setConfirmRestore(false);setNotice('上次向量设置已保存为待切换；重新加载后自动补齐索引（只编码变化部分），完成后再切换。原话、事实和新增聊天保留。');
      }catch(error){setNotice(error.message);}finally{setBusy(false);}};
      const localFields=selected?.engine==='fastembed'?[['rawRecallPython','Python 程序'],['rawRecallCacheDir','已有模型缓存目录'],['rawRecallBgeModelDir','已有 BGE 快照目录（可留空）']]
        :selected?.engine==='onnx'?[['rawRecallPython','Python 程序'],['rawRecallOnnxModel','0.6B ONNX 模型文件'],['rawRecallOnnxTokenizer','tokenizer.json 文件']]
        :[['rawRecallGgufModel','GGUF 模型文件'],['rawRecallLlamaCpuServer','CPU llama-server 程序'],['rawRecallLlamaCudaServer','CUDA llama-server 程序'],['rawRecallLlamaServer','兼容旧版 llama-server 路径']];
      return h('fieldset',{className:'memory-policy memory-model',disabled:busy},h('legend',null,'向量模型（Embedding）'),
        h('p',{className:'note'},'模型配置与实际运行状态分别显示；查看和保存不启动模型。切换保留正文及已有索引。'),
        h('div',{className:'memory-actions','aria-label':'模型设置模式'},h('button',{type:'button','aria-pressed':!expert,onClick:()=>setExpert(false)},'标准模式'),h('button',{type:'button','aria-pressed':expert,onClick:()=>setExpert(true)},'专家模式')),
        h('p',{className:'note'},'当前配置：'+(info.rawModel?.fields?.rawRecallModel??'未知')+(info.pendingRawModel?'；待生效：'+info.pendingRawModel.fields.rawRecallModel:'')),
        h('label',null,'查看模型 ',h('select',{'aria-label':'查看向量模型',value:draft.rawRecallModel,disabled:preparing,onChange:event=>changeModel(event.target.value)},
          h('optgroup',{label:'本地运行'},...info.rawModels.filter(model=>!model.cloud).map(model=>h('option',{key:model.id,value:model.id},model.label))),
          h('optgroup',{label:'云端 API'},...info.rawModels.filter(model=>model.cloud&&(!model.hidden||model.id===draft.rawRecallModel)).map(model=>h('option',{key:model.id,value:model.id},model.label))))),
        h('p',{className:'note'},(selected?.label??draft.rawRecallModel)+'；'+(cloud?'云端 API':selected?.engine??'本地')+'；向量维度 '+(draft.rawRecallDimensions||selected?.dimensions||'自动')),
        cloud?h(React.Fragment,null,
          h('p',{className:'note'},'云端会接收需要向量化的问题，以及纳入索引的已授权聊天原文、长期条目、想法日记和手选 Markdown。首次准备及后续更新可能产生向量 API 费用，由服务商单独收取。保存设置不会请求 API。'),
          h('div',{className:'memory-group-form'},field('rawRecallApiBase','API 地址'),selected?.custom&&field('rawRecallApiModel','模型名称'),selected?.custom&&field('rawRecallDimensions','向量维数','number'),h('label',null,'API Key（同一服务留空可保留）',h('input',{type:'password',autoComplete:'new-password',maxLength:8192,value:key,onChange:event=>setKey(event.target.value)}))),
          h('p',{className:'note'},'更换服务地址或业务空间时，请填写对应密钥；同一网关确实共用凭据时，可明确选择复用。'),
          h('label',null,h('input',{type:'checkbox',checked:reuseApiKey,disabled:Boolean(key.trim()),onChange:event=>setReuseApiKey(event.target.checked)}),'我确认当前填写的服务地址可以使用现有密钥或环境变量凭据'),
          (info.pendingRawModel??info.rawModel).hasSavedApiKey&&h('p',{className:'note'},'已保存 API Key，页面不会回显。'),
          h('label',null,h('input',{type:'checkbox',checked:draft.rawRecallAllowCloud,onChange:event=>update('rawRecallAllowCloud',event.target.checked)}),'我选择使用云端检索，并了解会发送上述内容及产生 API 费用'),
          expert&&h('details',{open:true},h('summary',null,'云端高级设置'),
            field('rawRecallApiKeyEnv','API Key 环境变量（可选）'),
            h('label',null,'向量维度 ',h('select',{value:draft.rawRecallDimensions,onChange:event=>update('rawRecallDimensions',Number(event.target.value))},h('option',{value:0},'自动（'+selected.dimensions+' 维）'),...(selected.allowedDimensions??[]).map(value=>h('option',{key:value,value},value+' 维')))),
            h('div',{className:'memory-group-form'},field('rawRecallTimeoutMs','单次编码超时（毫秒）','number'),field('rawRecallQueryWaitMs','检索总等待（毫秒，0 为自动）','number')),
            h('p',{className:'note'},'单次编码超时限制一次向量请求；检索总等待限制 memory_search 的整条链路。')))
        :h(React.Fragment,null,
          h('label',null,'运行设备 ',h('select',{'aria-label':'运行设备',value:draft.rawRecallDevice,disabled:preparing,onChange:event=>update('rawRecallDevice',event.target.value)},h('option',{value:'auto'},selected?.engine==='llamacpp'?'自动（优先 GPU）':'自动（当前后端使用 CPU）'),h('option',{value:'cpu'},'CPU'),h('option',{value:'cuda',disabled:selected?.engine!=='llamacpp'},selected?.engine==='llamacpp'?'GPU（NVIDIA CUDA）':'GPU（当前后端未适配）'))),
          h('p',{className:'note'},'草稿设备：'+deviceLabel(draft.rawRecallDevice)+'；已设置设备：'+deviceLabel(previous.rawRecallDevice)+'。'+(draft.rawRecallModel==='Qwen/Qwen3-Embedding-4B'?'4B 默认优先 GPU，CPU 备用 6 线程。':'')+'按需加载，空闲后释放；实际设备见运行回执。'),
          h(ModelPreparation,{info,draft,onPrepared:onSaved,onRunning:setPreparing}),
          h('details',{open:expert},h('summary',null,'高级设置：已有文件与资源'),h('div',{className:'memory-group-form'},...localFields.map(([name,label])=>field(name,label)),
            ...(selected?.engine==='llamacpp'?[field('rawRecallCpuThreads','4B CPU 备用线程数','number'),field('rawRecallGpuThreads','GPU 辅助 CPU 线程数','number')]:[field('rawRecallThreads','CPU 线程数（兼容设置）','number')]),field('rawRecallTimeoutMs','单次编码超时（毫秒）','number'),field('rawRecallQueryWaitMs','检索总等待（毫秒，0 为自动）','number'),
            h('label',null,'空闲后多少分钟释放模型（0 为常驻）',h('input',{type:'number',min:0,max:60,disabled:preparing,value:draft.rawRecallIdleMs/60000,onChange:event=>update('rawRecallIdleMs',Math.round(Number(event.target.value)*60000))}))),
            selected?.engine==='llamacpp'&&h('div',{className:'memory-group-form'},field('rawRecallThreads','其他 GGUF 型号 CPU 线程数（兼容设置）','number'))),h('p',{className:'note'},'单次编码超时限制一次向量请求；检索总等待限制 memory_search 的整条链路。')),
        info.pendingRawModel&&h('p',{className:'note'},'已有模型选择等待重新加载。当前仍使用之前的模型。'),
        info.rawRecall?.embeddingUsage?.calls>0&&h('p',{className:'note'},`已记录云端向量调用 ${info.rawRecall.embeddingUsage.calls} 次，已报告用量 ${info.rawRecall.embeddingUsage.reportedTokens} token，另有 ${info.rawRecall.embeddingUsage.unknownUsageCalls} 次用量未知。这里不包含作答模型费用。`),
        info.rawRecall?.backend?.cloudPaused&&h('p',{className:'memory-notice',role:'status'},'云端检索因调用未成功已暂停，避免重复发送和计费；检查 API 设置后重新加载可重试。文本检索仍可用。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||preparing||!dirty||(cloud&&!draft.rawRecallAllowCloud),onClick:()=>save(false)},busy?'保存中':'应用运行设置'),info.pendingRawModel&&h('button',{type:'button',disabled:busy||preparing,onClick:()=>save(true)},'取消待切换')),
        h(ModelSwitch,{info,modelId:draft.rawRecallModel,draft,dirty,cloud,onStage:extra=>save(false,extra),key:'switch'}),
        info.pendingRawModelSwitch&&h('p',{className:'note'},'已确认切换：重新加载后自动开始准备索引。'),
        h(MemoryRuntimeSettings,{info,modelId:draft.rawRecallModel,cloud,dirty,key:'runtime'}),
        info.rawModelHistory?.[0]&&h('div',{className:'note'},h('p',null,'上次使用：'+info.rawModelHistory[0].model),
          info.rawModelHistory[0].cloud&&h('label',null,h('input',{type:'checkbox',checked:rollbackCloud,onChange:event=>setRollbackCloud(event.target.checked)}),'恢复该设置会使用云端并产生 API 费用'),
          !confirmRestore&&h('button',{type:'button',disabled:busy||preparing||(info.rawModelHistory[0].cloud&&!rollbackCloud),onClick:()=>setConfirmRestore(true)},'恢复上次向量设置'),
          confirmRestore&&h('div',{role:'dialog','aria-label':'确认恢复'},h('p',null,'将切回 '+info.rawModelHistory[0].model+'。确认后保存，重新加载后自动补齐它的已有索引（只编码变化部分），全部完成后才切换；期间向量检索暂不可用，文字与条目检索不受影响。'+(info.rawModelHistory[0].cloud?'待编码内容会发送到该云端服务并按服务商价格计费。':'')),
            h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:restore},'确认恢复'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirmRestore(false)},'返回')))),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function BootstrapSetup(){
      const [info,setInfo]=React.useState(null),[fields,setFields]=React.useState({directory:'',captureProvider:'',captureModel:''}),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[models,setModels]=React.useState([]),[loadingModels,setLoadingModels]=React.useState(false),[selected,setSelected]=React.useState([]);
      const providerRef=React.useRef('');
      const applyInfo=value=>{setInfo(value);setSelected((value.sessions??[]).filter(item=>item.bound).map(item=>item.id));};
      const syncFields=value=>{providerRef.current=value.captureProvider??'';setFields({directory:value.personalDirectory??'',captureProvider:value.captureProvider??'',captureModel:value.captureModel??''});};
      React.useEffect(()=>{let live=true;fetch('/api/basic-memory-bootstrap',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(value=>{if(live&&value){providerRef.current=value.captureProvider??'';applyInfo(value);setFields(current=>({...current,directory:value.personalDirectory??'',captureProvider:value.captureProvider??'',captureModel:value.captureModel??''}));}}).catch(()=>{});return()=>{live=false;};},[]);
      const create=async()=>{setBusy(true);setNotice('');try{const response=await fetch('/api/basic-memory-bootstrap',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify(fields)}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'准备失败');const refreshed=await fetch('/api/basic-memory-bootstrap',{credentials:'same-origin'});if(!refreshed.ok)throw Error('新库已准备，请刷新页面后继续');const result=await refreshed.json();applyInfo(result);syncFields(result);setNotice('新库和配置已准备；当前记忆继续运行，请选择需要使用新库的聊天。');}catch(error){setNotice(error.message||'准备失败');}finally{setBusy(false);}};
      const saveSelection=async()=>{setBusy(true);setNotice('');try{const response=await fetch('/api/basic-memory-bootstrap/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({ids:selected,revision:info.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');applyInfo(value);setNotice('聊天选择已保存，当前仍使用原记忆。');}catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}};
      const saveOptions=async()=>{setBusy(true);setNotice('');try{const response=await fetch('/api/basic-memory-bootstrap/options',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({...fields,revision:info.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');applyInfo(value);syncFields(value);setNotice('准备配置已更新，当前仍使用原记忆。');}catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}};
      const activation=async action=>{setBusy(true);setNotice('');try{const response=await fetch('/api/basic-memory-bootstrap/activation',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({action,revision:info.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'操作失败');applyInfo(value);setNotice(action==='cancel'?'已取消下次启用。':'已安排下次 DSH 启动时启用；当前聊天和记忆继续使用原设置。');}catch(error){setNotice(error.message||'操作失败');}finally{setBusy(false);}};
      const loadModels=async()=>{const provider=fields.captureProvider;setLoadingModels(true);setNotice('');try{const response=await fetch('/api/basic-memory-bootstrap/models?provider='+encodeURIComponent(provider),{credentials:'same-origin'}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'读取模型失败');if(providerRef.current===provider){setModels(value.models);setNotice(value.models.length?'已获取模型，可从整理模型输入框选择。':'该服务未返回模型，可手动填写。');}}catch(error){if(providerRef.current===provider){setModels([]);setNotice(error.message||'读取模型失败');}}finally{setLoadingModels(false);}};
      if(!info)return null;
      const inputs=[['directory','新记忆库目录'],['captureProvider','整理服务'],['captureModel','整理模型']];
      const bound=(info.sessions??[]).filter(item=>item.bound).map(item=>item.id),dirty=selected.length!==bound.length||selected.some(id=>!bound.includes(id)),optionsDirty=fields.captureProvider!==info.captureProvider||fields.captureModel!==info.captureModel;
      const editPrepared=h('details',{className:'memory-group-options'},h('summary',null,'修改准备配置'),h('p',{className:'note'},'只更新尚未启用的后端与整理模型；记忆库目录不变。若已安排启用，请先取消。'),h('fieldset',{className:'memory-policy',disabled:busy||Boolean(info.activation)},h('div',{className:'memory-group-form'},...inputs.filter(([key])=>key!=='directory').map(([key,label])=>h('label',{key},label,h('input',{value:fields[key],list:key==='captureProvider'?'bootstrap-providers':key==='captureModel'?'bootstrap-models':undefined,onChange:e=>{setFields({...fields,[key]:e.target.value});if(key==='captureProvider'){providerRef.current=e.target.value;setModels([]);setNotice('');}}})))),h('datalist',{id:'bootstrap-providers'},...(info.providers??[]).map(item=>h('option',{key:item.id,value:item.id},item.name))),h('datalist',{id:'bootstrap-models'},...models.map(item=>h('option',{key:item.id,value:item.id},item.name))),h('div',{className:'memory-actions'},h('button',{type:'button',disabled:loadingModels||!fields.captureProvider.trim(),onClick:loadModels},loadingModels?'正在读取':'获取可用模型')),h('label',null,h('input',{type:'checkbox',checked:fields.offline,onChange:e=>setFields({...fields,offline:e.target.checked})}),'仅使用已有模型缓存'),h('div',{className:'memory-actions'},h('button',{type:'button',onClick:saveOptions},'保存准备配置'))));
      const prepared=h(React.Fragment,null,h('p',{className:'note'},'已准备配置：'+info.configFile),h('p',{className:'note'},'启用后，只有选中的聊天使用新库；未选聊天不会自动使用新库或旧库。已有记忆保留，不会复制。'),editPrepared,optionsDirty&&!info.activation&&h('p',{className:'note'},'准备配置有未保存的更改。'),info.sessionsError&&h('p',{className:'memory-notice',role:'status'},info.sessionsError),h('fieldset',{className:'memory-sessions',disabled:busy||Boolean(info.activation)},h('legend',null,'使用新记忆库的 DSH 聊天'),...(info.sessions??[]).map(item=>h('label',{key:item.id,className:'memory-session'},h('input',{type:'checkbox',checked:selected.includes(item.id),onChange:e=>setSelected(e.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id))}),h('span',null,item.title,h('small',null,item.workspace))))),dirty&&h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||Boolean(info.activation),onClick:saveSelection},'保存聊天选择')),info.activationError&&h('p',{className:'memory-notice',role:'status'},info.activationError),info.activation==='scheduled'&&h('p',{className:'note'},'已安排下次 DSH 启动时启用；当前仍使用原记忆。'),info.activationInUse&&h('p',{className:'note'},'另一个 DSH 进程正在使用此配置。'),h('div',{className:'memory-actions'},info.activation!=='scheduled'&&h('button',{type:'button',disabled:busy||dirty||optionsDirty||!selected.length||info.activationInUse,onClick:()=>activation('schedule')},'下次启动时启用'),info.activation&&h('button',{type:'button',disabled:busy||info.activationInUse,onClick:()=>activation('cancel')},'取消下次启用')));
      return h('section',{className:'memory-sessions'},h('h3',null,'准备独立记忆库'),h('p',{className:'note'},'为当前 DSH 配置准备一个独立新库，不复制或改写已有记忆。准备期间当前记忆会继续使用。'),info.configured?prepared:h(React.Fragment,null,h('div',{className:'memory-group-form'},...inputs.map(([key,label])=>h('label',{key},label,h('input',{value:fields[key],list:key==='captureProvider'?'bootstrap-providers':key==='captureModel'?'bootstrap-models':undefined,onChange:e=>{setFields({...fields,[key]:e.target.value});if(key==='captureProvider'){providerRef.current=e.target.value;setModels([]);setNotice('');}}})))),h('datalist',{id:'bootstrap-providers'},...(info.providers??[]).map(item=>h('option',{key:item.id,value:item.id},item.name))),h('datalist',{id:'bootstrap-models'},...models.map(item=>h('option',{key:item.id,value:item.id},item.name))),h('div',{className:'memory-actions'},h('button',{type:'button',disabled:loadingModels||!fields.captureProvider.trim(),onClick:loadModels},loadingModels?'正在读取':'获取可用模型')),h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||!fields.directory.trim()||!fields.captureProvider.trim()||!fields.captureModel.trim(),onClick:create},busy?'正在准备，请稍候':'准备新库和配置'))),notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function HandoffSettings({revision,onSaved}){
      const [info,setInfo]=React.useState(null),[choice,setChoice]=React.useState('4096'),[custom,setCustom]=React.useState('4096');
      const [busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      React.useEffect(()=>{
        let live=true;
        fetch('/api/basic-memory-settings/handoff',{credentials:'same-origin'}).then(async response=>{
          if(!response.ok)return;const value=await response.json();
          if(live&&value.ok){setInfo(value);setChoice([4096,8192].includes(value.tokens)?String(value.tokens):'custom');setCustom(String(value.tokens));}
        }).catch(()=>{});
        return()=>{live=false;};
      },[revision]);
      if(!info)return null;
      const tokens=Number(choice==='custom'?custom:choice),valid=Number.isSafeInteger(tokens)&&tokens>=1&&tokens<=16384;
      const save=async()=>{
        setBusy(true);setNotice('');
        try{
          const response=await fetch('/api/basic-memory-settings/handoff',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({tokens,revision:info.revision})});
          const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');
          setInfo(value);setNotice(value.activeTokens===tokens?'已保存，下次真正触发接续时使用。':'已保存，重新加载后生效。');onSaved?.();
        }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}
      };
      return h('fieldset',{className:'memory-policy',disabled:busy},h('legend',null,'短期接续长度'),
        h('p',{className:'note'},'切换对话、连接变化或上次回答未完成时使用一次；连续正常聊天保留已注入内容。'),
        h('label',null,'注入长度',h('select',{'aria-label':'短期接续长度',value:choice,onChange:event=>setChoice(event.target.value)},
          h('option',{value:'4096'},'4K（推荐）'),h('option',{value:'8192'},'8K（保留更多）'),h('option',{value:'custom'},'自定义'))),
        choice==='custom'&&h('label',null,'tokens',h('input',{'aria-label':'自定义接续 tokens',type:'number',min:1,max:16384,step:1,value:custom,onChange:event=>setCustom(event.target.value)})),
        h('p',{className:'note'},'K = 1024 tokens，最多 16K；按估算计量。保留越多，模型输入消耗越多。'),
        info.activeTokens!==info.tokens&&h('p',{className:'note'},'已保存长度与当前运行长度不同，请重新加载记忆框架。'),
        !valid&&h('p',{className:'memory-notice',role:'status'},'请输入 1–16384 的整数。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',disabled:!valid||tokens===info.tokens,onClick:save},busy?'正在保存':'保存接续长度')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function TimeZoneSettings({info,onSaved}){
      const [draft,setDraft]=React.useState(info.timeZoneConfigured??''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      React.useEffect(()=>setDraft(info.timeZoneConfigured??''),[info.revision]);
      const value=draft.trim(),saved=info.timeZoneConfigured??'',dirty=value!==saved;
      const active=info.activeTimeZone??info.timeZone;
      const save=async()=>{
        setBusy(true);setNotice('');
        try{
          const response=await fetch('/api/basic-memory-settings/time-zone',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({timeZone:value,revision:info.revision})});
          const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'保存失败');
          onSaved?.(result);setNotice('时区已保存；重新加载记忆框架后生效。');
        }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}
      };
      return h('fieldset',{className:'memory-policy',disabled:busy},h('legend',null,'时区'),
        h('p',{className:'note'},'当前生效：'+(active||'未报告')+'；本机时区：'+(info.timeZoneHost||'未报告')+'。留空使用北京时间（Asia/Shanghai）；在其他地区可填写当地时区，如 America/Los_Angeles。'),
        h('label',null,'个人时区',h('input',{'aria-label':'个人时区',value:draft,placeholder:'例如 America/Los_Angeles',onChange:event=>setDraft(event.target.value)})),
        info.timeZoneError&&h('p',{className:'memory-notice',role:'status'},info.timeZoneError),
        info.activeTimeZoneError&&info.activeTimeZoneError!==info.timeZoneError&&h('p',{className:'memory-notice',role:'status'},info.activeTimeZoneError),
        info.timeZone!==active&&h('p',{className:'note'},'已保存的时区重新加载记忆框架后生效。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',disabled:!dirty,onClick:save},busy?'正在保存':'保存时区')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function MemoryReviewSettings(){
      const [list,setList]=React.useState(null),[selected,setSelected]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      const request=React.useRef(null);
      React.useEffect(()=>()=>request.current?.abort(),[]);
      const reasons={
        'content-or-importance-conflict':'正文或重要性有变化',
        'target-revision-changed':'条目已被修改',
        'backend-write-conflict':'保存时遇到并发修改',
        'managed-body-changed':'正文格式有变化',
        'write-outcome-unknown':'需核对上次写入结果',
        'submission-pending':'已提交，待核对结果',
      };
      async function call(query,signal,operation){
        const response=await fetch('/api/basic-memory-settings/reviews'+query,{credentials:'same-origin',signal,
          ...(operation?{method:'POST',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify(operation)}:{})});
        const value=await response.json();
        if(!response.ok||!value.ok)throw Error(value.error||'审核操作失败');
        return value;
      }
      async function run(task){
        if(request.current)return;
        const controller=new AbortController();
        request.current=controller;setBusy(true);setNotice('');
        try{await task(controller.signal);}
        catch(error){if(!controller.signal.aborted)setNotice(error.message);}
        finally{request.current=null;if(!controller.signal.aborted)setBusy(false);}
      }
      const listPage=async(signal,after='')=>{
        const page=await call(after?'?afterId='+encodeURIComponent(after):'',signal);
        setList(current=>after?{...page,items:[...current.items,...page.items]}:page);
      };
      const show=async(id,signal)=>{
        const result=await call('?operationId='+encodeURIComponent(id),signal);
        setSelected(result.review);
      };
      function decide(action){
        return run(async signal=>{
          const {result}=await call('',signal,{action,operationId:selected.operationId,revision:selected.revision});
          if(result.state==='review'){
            await show(selected.operationId,signal);
            setNotice('条目仍需审核，请重新核对当前版本。');
          }else{
            setSelected(null);await listPage(signal);
            setNotice(result.state==='committed'?'已接受，更新已写入记忆库。':'已拒绝，保留当前条目。');
          }
        });
      }
      const details=(label,entry)=>h('section',{className:'memory-policy'},h('h4',null,label),entry?
        h(React.Fragment,null,h('p',{className:'note'},[entry.type,entry.state?.validity,entry.state?.progress].filter(Boolean).join(' · ')),
          h('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},entry.content),
          entry.importance&&h('p',{className:'note'},`重要程度 ${entry.importance.level} · ${entry.importance.reason}`),
          entry.tags?.length?h('p',{className:'note'},entry.tags.join('、')):null):h('p',{className:'note'},'当前版本或原文依据已不可用。'));
      return h('section',{className:'memory-sessions'},h('h3',null,'人工审核'),
        h('p',{className:'note'},'对照记忆库中的当前条目与整理建议。接受后保存旧版本，拒绝后保留当前条目。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>run(signal=>listPage(signal))},list?'刷新审核列表':'读取待审核')),
        list&&!list.items.length&&h('p',{className:'note'},'暂无待审核建议。'),
        list&&h('ul',null,...list.items.map(item=>h('li',{key:item.operationId},
          h('button',{type:'button',disabled:busy,onClick:()=>run(signal=>show(item.operationId,signal))},`${item.type} · ${reasons[item.reason]??'核对当前版本'}`)))),
        list?.nextAfter&&h('button',{type:'button',disabled:busy,onClick:()=>run(signal=>listPage(signal,list.nextAfter))},'加载更多建议'),
        selected&&h(React.Fragment,null,details('当前条目',selected.current),details('整理建议',selected.proposed),
          selected.sources.length>0&&h('details',{className:'memory-group-options'},h('summary',null,'查看原文依据'),
            ...selected.sources.map(source=>h('p',{key:source.id+':'+source.revision,style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},
              `${source.role==='user'?'用户':'助手'} · ${source.text}`))),
          h('div',{className:'memory-actions'},
            h('button',{type:'button',disabled:busy||!selected.canApprove,onClick:()=>decide('approve')},selected.submitted?'核对提交结果':'接受建议'),
            h('button',{type:'button',disabled:busy||!selected.canReject,onClick:()=>decide('reject')},'拒绝建议'),
            h('button',{type:'button',disabled:busy,onClick:()=>run(signal=>show(selected.operationId,signal))},'刷新当前条目'),
            h('button',{type:'button',disabled:busy,onClick:()=>setSelected(null)},'关闭对照'))),
        busy&&h('p',{role:'status'},'正在处理…'),notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function MemoryDocumentSelection(){
      const [current,setCurrent]=React.useState(null),[draft,setDraft]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      const identifiers=draft.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      async function load(save){
        setBusy(true);setNotice('');
        try{
          const response=await fetch('/api/basic-memory-settings/documents',{credentials:'same-origin',...(save?{method:'POST',
            headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({identifiers,revision:current.revision})}:{})});
          const value=await response.json();
          if(!response.ok||!value.ok)throw Error(value.error||'读取资料选择失败');
          setCurrent(value);setDraft(value.identifiers.join('\n'));
          if(save)setNotice('已保存资料选择。索引更新进度见「状态与维护」。');
        }catch(error){setNotice(error.message);}finally{setBusy(false);}
      }
      const dirty=current&&JSON.stringify(identifiers)!==JSON.stringify(current.identifiers);
      return h('section',{className:'memory-sessions'},h('h3',null,'手选检索资料'),
        h('p',{className:'note'},'填写当前记忆库内的 Markdown 相对路径，每行一份。删除列表中的路径并保存可撤回选择。'),
        h('button',{type:'button',disabled:busy,onClick:()=>load(false)},current?'刷新所选资料':'读取所选资料'),
        current&&h('label',null,'资料相对路径',h('textarea',{value:draft,rows:5,disabled:busy,onChange:e=>setDraft(e.target.value)})),
        current&&h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||!dirty,onClick:()=>load(true)},'保存资料选择')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    // One model chosen from a list; files, threads and timeouts are managed by the installer (expert view in 维护).
    const TIER_INFO={light:['轻量','CPU 运行，占用约几百 MB 内存'],balanced:['均衡','CPU 运行，占用约 1 GB 内存'],quality:['高质量','优先用显卡，约 3 GB 显存；无显卡时用 CPU'],
      advanced:['高级','优先用显卡，约 5–6 GB 显存'],cloud:['云端','不占本机资源；检索内容发送到云端，按量收费']};
    const modelTitle=model=>{const tier=(TIER_INFO[model.tier??(model.cloud?'cloud':'')]??[''])[0];return (tier?tier+' · ':'')+model.label.split(' · ')[0].replace(/^云端\s+/u,'');};
    function ModelPicker({info,onSaved}){
      const base=(info.pendingRawModel??info.rawModel)?.fields??{};
      const [draft,setDraft]=React.useState(null),[key,setKey]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[preparing,setPreparing]=React.useState(false),[inventory,setInventory]=React.useState(null);
      const inventoryRequest=React.useRef(0);
      const loadInventory=React.useCallback(async downloadedModel=>{
        const ticket=++inventoryRequest.current;
        try{
          const response=await fetch('/api/basic-memory-settings/model-install',{method:'POST',credentials:'same-origin',
            headers:{'content-type':'application/json','x-basic-memory-settings':'1'},
            body:JSON.stringify({action:'inventory',revision:info.revision})});
          const value=await response.json();
          if(!response.ok||!value.ok||!value.inventory)throw Error(value.error || '无法读取模型安装状态');
          if(ticket!==inventoryRequest.current)return;
          setInventory(value.inventory);
          if(downloadedModel)setDraft(current=>{
            if(current?.rawRecallModel!==downloadedModel)return current;
            const entry=value.inventory.models?.find(model=>model.id===downloadedModel);
            return entry?.installed?{...current,...entry.settings}:current;
          });
        }catch{if(ticket===inventoryRequest.current)setInventory(null);}
      },[info.revision]);
      React.useEffect(()=>{setDraft({rawRecallDevice:'auto',rawRecallIdleMs:0,rawRecallResidentHours:'',...base});setKey('');},[info.revision]);
      React.useEffect(()=>{setInventory(null);loadInventory();},[loadInventory]);
      if(!draft||!info.rawModels)return null;
      const selected=info.rawModels.find(model=>model.id===draft.rawRecallModel),cloud=Boolean(selected?.cloud);
      const selectedInventory=!cloud?inventory?.models?.find(model=>model.id===draft.rawRecallModel):null;
      const installed=selectedInventory?selectedInventory.installed:null,unavailable=installed===false;
      const residency=!draft.rawRecallIdleMs?'always':draft.rawRecallResidentHours?'hours':'idle';
      const choose=model=>{
        const entry=!model.cloud?inventory?.models?.find(row=>row.id===model.id):null;
        setNotice('');setDraft(current=>({...current,rawRecallModel:model.id,rawRecallDimensions:0,rawRecallAllowCloud:false,rawRecallInstallReceipt:model.id===base.rawRecallModel?base.rawRecallInstallReceipt:'',
        rawRecallTimeoutMs:model.engine==='llamacpp'?10000:3000,rawRecallDevice:model.engine==='llamacpp'?'auto':'cpu',...(model.engine==='llamacpp'&&model.id!==current.rawRecallModel?{rawRecallGgufModel:''}:{}),
        ...(entry?.installed&&model.id!==base.rawRecallModel?entry.settings:{}),
        // A custom service starts blank unless it is the one already saved.
        ...(model.custom?(model.id===base.rawRecallModel?{rawRecallApiBase:base.rawRecallApiBase??'',rawRecallApiModel:base.rawRecallApiModel??'',rawRecallDimensions:base.rawRecallDimensions??0}:{rawRecallApiBase:'',rawRecallApiModel:''}):{})}));};
      const custom=Boolean(selected?.custom),customOk=!custom||Boolean(String(draft.rawRecallApiBase??'').trim()&&String(draft.rawRecallApiModel??'').trim());
      const offered=model=>!model.hidden||model.id===draft.rawRecallModel||model.id===info.rawModel?.fields?.rawRecallModel;
      const dirty=JSON.stringify({rawRecallDevice:'auto',rawRecallIdleMs:0,rawRecallResidentHours:'',...base})!==JSON.stringify(draft)||Boolean(key.trim());
      // The choice may have been made before the install check answered; the saved paths always come from it.
      const installedSettings=()=>selectedInventory?.installed&&draft.rawRecallModel!==base.rawRecallModel?{...draft,...selectedInventory.settings}:draft;
      const save=async()=>{setBusy(true);setNotice('');try{
        const response=await fetch('/api/basic-memory-settings/model',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,settings:installedSettings(),...(key.trim()?{apiKey:key.trim()}:{})})});
        const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');onSaved(value);setKey('');setNotice('已保存，模型在后台切换，进度见「状态」。');
      }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}};
      const current=info.rawModel?.fields?.rawRecallModel;
      return h('fieldset',{className:'memory-policy memory-model',disabled:busy},h('legend',null,'检索模型'),
        h('p',{className:'note'},'用来按意思查找聊天原话和记忆。模型越大找得越准，占用也越多；切换不会丢失已有记忆。'),
        h('label',null,'模型',h('select',{'aria-label':'检索模型',value:draft.rawRecallModel,disabled:preparing,onChange:event=>{const model=info.rawModels.find(row=>row.id===event.target.value);if(model)choose(model);}},
          ...[['本地运行',false],['云端 API',true]].map(([group,isCloud])=>h('optgroup',{key:group,label:group},...info.rawModels.filter(model=>Boolean(model.cloud)===isCloud&&offered(model)).map(model=>
            {
              const entry=!model.cloud?inventory?.models?.find(row=>row.id===model.id):null;
              return h('option',{key:model.id,value:model.id},modelTitle(model)+(model.id===current?'（当前使用）':entry?(entry.installed?'（已安装）':'（未安装）'):''));
            })))) ),
        selected&&h('p',{className:'note'},(TIER_INFO[selected.tier??(selected.cloud?'cloud':'')]??['',''])[1]+(selected.id===current?'。当前使用':'')),
        cloud?h(React.Fragment,null,
          custom&&h(React.Fragment,null,
            h('p',{className:'note'},'填写任意兼容 OpenAI 向量接口（/embeddings）的服务。地址需为 https。'),
            h('label',null,'API 地址',h('input',{type:'url',value:draft.rawRecallApiBase??'',placeholder:'https://服务地址/v1',onChange:event=>setDraft({...draft,rawRecallApiBase:event.target.value})})),
            h('label',null,'模型名称',h('input',{type:'text',maxLength:200,value:draft.rawRecallApiModel??'',placeholder:'服务商文档里的向量模型名',onChange:event=>setDraft({...draft,rawRecallApiModel:event.target.value})})),
            h('label',null,'向量维数（模型实际输出的维数）',h('input',{type:'number',min:1,max:4096,value:draft.rawRecallDimensions||1024,onChange:event=>setDraft({...draft,rawRecallDimensions:Math.max(1,Math.min(4096,Math.round(Number(event.target.value))||1))})}))),
          h('label',null,'API Key',h('input',{type:'password',autoComplete:'new-password',maxLength:8192,value:key,placeholder:(info.pendingRawModel??info.rawModel)?.hasSavedApiKey?'已保存，留空沿用':'',onChange:event=>setKey(event.target.value)})),
          h('label',null,h('input',{type:'checkbox',checked:Boolean(draft.rawRecallAllowCloud),onChange:event=>setDraft({...draft,rawRecallAllowCloud:event.target.checked})}),'我知道检索内容会发送到云端，并会产生费用'))
        :h(React.Fragment,null,installed===true&&selected?.id!==current&&h('p',{className:'note'},'已安装。点「保存」后启用。'),
          h(ModelPreparation,{info,draft,onPrepared:onSaved,onDownloaded:loadInventory,onRunning:setPreparing,simple:true,installed,downloadBytes:selectedInventory?.downloadBytes||0}),
          h('details',null,h('summary',null,'高级'),h('div',{className:'memory-group-form'},
            h('label',null,'运行设备',h('select',{value:draft.rawRecallDevice,disabled:preparing,onChange:event=>setDraft({...draft,rawRecallDevice:event.target.value})},
              h('option',{value:'auto'},'自动'),h('option',{value:'cpu'},'CPU'),h('option',{value:'cuda',disabled:selected?.engine!=='llamacpp'},'显卡'))),
            h('label',null,'模型常驻',h('select',{value:residency,disabled:preparing,onChange:event=>{const value=event.target.value;
              setDraft({...draft,rawRecallIdleMs:value==='always'?0:(draft.rawRecallIdleMs||600000),rawRecallResidentHours:value==='hours'?(draft.rawRecallResidentHours||'08:00-01:00'):''});}},
              h('option',{value:'always'},'一直加载'),h('option',{value:'idle'},'空闲一段时间后释放'),h('option',{value:'hours'},'按时段常驻，其余时间空闲释放'))),
            residency!=='always'&&h('label',null,'空闲多少分钟后释放',h('input',{type:'number',min:1,max:60,disabled:preparing,value:Math.round((draft.rawRecallIdleMs||600000)/60000),onChange:event=>setDraft({...draft,rawRecallIdleMs:Math.max(1,Math.round(Number(event.target.value)))*60000})})),
            residency==='hours'&&h('label',null,'常驻时段（如 08:00-01:00，可跨午夜）',h('input',{type:'text',disabled:preparing,value:draft.rawRecallResidentHours??'',onChange:event=>setDraft({...draft,rawRecallResidentHours:event.target.value})}))))),
        info.rawRecall?.backend?.cloudPaused&&h('p',{className:'memory-notice',role:'status'},'云端检索调用失败后已暂停；检查 API Key 后重新保存即可恢复。文字检索不受影响。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||preparing||unavailable||!dirty||(cloud&&!draft.rawRecallAllowCloud)||!customOk,onClick:save},busy?'保存中':'保存')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function Page({readStatus}){
      const [tab,setTab]=React.useState('basic'),[state,setState]=React.useState({status:'loading'});
      const [sessionInfo,setSessionInfo]=React.useState(null),[selected,setSelected]=React.useState([]),[sessionError,setSessionError]=React.useState(''),[saving,setSaving]=React.useState(false);
      const [sessionNotice,setSessionNotice]=React.useState(''),[sessionFilter,setSessionFilter]=React.useState('');
      const sessionRequest=React.useRef(0),savingSessions=React.useRef(false);
      const [newDirectory,setNewDirectory]=React.useState(''),[creatingLibrary,setCreatingLibrary]=React.useState(false),[libraryNotice,setLibraryNotice]=React.useState('');
      const [flagDraft,setFlagDraft]=React.useState(null),[savingFlags,setSavingFlags]=React.useState(false),[flagNotice,setFlagNotice]=React.useState('');
      const [onDemand,setOnDemand]=React.useState(false);
      React.useEffect(()=>{let live=true;readStatus().then(value=>{if(live)setState(value);},()=>{if(live)setState({status:'error'});});return()=>{live=false;};},[readStatus]);
      const refreshStatus=React.useCallback(async(syncSelection=false)=>{
        if(savingSessions.current)return;
        const ticket=++sessionRequest.current;
        try{const value=await sessionSettings();if(ticket===sessionRequest.current){setOnDemand(hasSessionMemory(value));setSessionInfo(value);if(syncSelection===true)setSelected(enabledSessionIds(value));setSessionError('');}}
        catch(error){if(ticket===sessionRequest.current)setSessionError(error.message||'无法读取运行状态');}
      },[]);
      React.useEffect(()=>{refreshStatus(true);const changed=()=>{if(savingSessions.current)return;setSessionNotice('对话记忆设置已更新。');refreshStatus(true);};window.addEventListener(sessionsChanged,changed);return()=>{sessionRequest.current++;window.removeEventListener(sessionsChanged,changed);};},[refreshStatus]);
      // Other existing settings writes return configuration, not the runtime opt-in receipt.
      React.useEffect(()=>{if(sessionInfo&&!sessionInfo.sessionMemory)refreshStatus(true);},[sessionInfo?.revision,refreshStatus]);
      React.useEffect(()=>{if(!sessionInfo?.pendingTurns)return;const timer=setInterval(()=>{if(savingSessions.current)return;const ticket=sessionRequest.current;sessionSettings().then(value=>{if(ticket===sessionRequest.current)setSessionInfo(current=>current?.revision===value.revision?{...current,pendingTurns:value.pendingTurns,runtime:value.runtime,sessionMemory:value.sessionMemory}:current);}).catch(()=>{});},2000);return()=>clearInterval(timer);},[sessionInfo?.pendingTurns]);
      React.useEffect(()=>{if(sessionInfo?.flags)setFlagDraft(sessionInfo.pendingFlags??sessionInfo.flags);},[sessionInfo?.revision]);
      const saveSessions=async(change={action:'replace',value:selected})=>{
        if(savingSessions.current||!hasSessionMemory(sessionInfo))return;
        savingSessions.current=true;const ticket=++sessionRequest.current;setSaving(true);setSessionError('');setSessionNotice('');
        try{const value=await sessionSettings(change,sessionInfo.revision);if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));setSessionNotice('对话选择已保存。开启从下一新回合生效；重新开启不补记关闭期间的内容。');}window.dispatchEvent(new Event(sessionsChanged));}
        catch(error){try{const value=await sessionSettings();if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));}}catch{}if(ticket===sessionRequest.current)setSessionError(error.message||'保存失败');}
        finally{savingSessions.current=false;if(ticket===sessionRequest.current)setSaving(false);}
      };
      const createLibrary=async()=>{setCreatingLibrary(true);setLibraryNotice('');try{const response=await fetch('/api/basic-memory-settings/libraries',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({action:'create',directory:newDirectory.trim(),revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'创建失败');setLibraryNotice(value.alreadyInitialized?'该目录已有初始化的记忆库；当前使用的库没有改变。':'新记忆库已创建；当前使用的库没有改变。');}catch(error){await refreshStatus();setLibraryNotice(error.message||'创建失败');}finally{setCreatingLibrary(false);}};
      const selectLibrary=async()=>{setCreatingLibrary(true);setLibraryNotice('');try{const response=await fetch('/api/basic-memory-settings/libraries',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({action:'select',directory:newDirectory.trim(),revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'选择失败');setSessionInfo(value);setLibraryNotice(value.pendingDirectory?'已登记目标库，当前库继续使用；下次重新加载时会再次检查待处理内容。':'已取消待切换的记忆库。');}catch(error){await refreshStatus();setLibraryNotice(error.message||'选择失败');}finally{setCreatingLibrary(false);}};
      const saveFlags=async()=>{setSavingFlags(true);setFlagNotice('');try{const response=await fetch('/api/basic-memory-settings/flags',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({flags:flagDraft,revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');setSessionInfo(value);setFlagNotice(value.pendingFlags?'设置已保存；当前对话继续使用原设置，下次重新加载后生效。':'已恢复当前生效的设置。');}catch(error){await refreshStatus();setFlagNotice(error.message||'保存失败');}finally{setSavingFlags(false);}};
      const tabs=[['basic','记忆'],['model','检索模型'],['status','状态'],['maintenance','维护']];
      const core=state.status==='loading'?'正在检查':state.status==='error'?'无法读取':state.core?'已加载':'未加载';
      let content;
      if(tab==='basic'){
        const current=enabledSessionIds(sessionInfo),dirty=Boolean(sessionInfo)&&([...selected].sort().join('\0')!==[...current].sort().join('\0'));
        const sessions=(sessionInfo?.sessions??[]).filter(s=>(s.title+' '+s.id+' '+s.workspace).toLocaleLowerCase().includes(sessionFilter.toLocaleLowerCase()));
        content=h(React.Fragment,null,h('h3',null,'记住哪些对话'),h('div',{className:'memory-line'},h('span',null,'记忆框架'),h('span',null,core)),sessionInfo&&h('p',{className:'note'},sessionInfo.runtime==='loaded'?(sessionInfo.pendingTurns?'已保存；部分对话等待下一新回合生效。':'记忆框架已加载，各对话记忆状态见下方。'):sessionInfo.runtime==='reload-required'?'更改已保存，重新加载记忆框架后生效。':'记忆框架尚未报告设置已加载。'),
          sessionInfo&&h('fieldset',{className:'memory-sessions',disabled:saving||!hasSessionMemory(sessionInfo)},
            h('legend',null,'对话'),
            h('p',{className:'note'},'只有开启的对话会被记住，从下一句开始生效；关闭不会删除已记住的内容。'),
            !hasSessionMemory(sessionInfo)&&h('p',{className:'memory-notice',role:'status'},'当前运行版本尚未接入对话记忆开关；旧绑定不作为新授权。'),
            h('div',{className:'memory-group-form'},h('label',null,'查找对话',h('input',{type:'search',value:sessionFilter,onChange:e=>setSessionFilter(e.target.value),placeholder:'标题、对话 ID 或工作区'}))),
            !sessionInfo.sessions?.length?h('p',{className:'note'},'当前没有可选择的对话，请先打开一个对话。'):!sessions.length?h('p',{className:'note'},'没有匹配的对话。'):
              h('div',{className:'memory-session-list'},...sessions.map(s=>h('div',{className:'memory-session-row',key:s.id},
                h('label',{className:'memory-session'},h('input',{type:'checkbox',checked:selected.includes(s.id),disabled:s.unavailable&&!current.includes(s.id),'aria-label':'选择对话：'+s.title,onChange:e=>{setSelected(e.target.checked?[...selected,s.id]:selected.filter(id=>id!==s.id));setSessionNotice('');}}),
                  h('span',null,s.title,h('small',null,s.unavailable?'当前不可用':s.workspace),h('small',{role:'status'},sessionStateText(sessionInfo,s.id)),selected.includes(s.id)!==current.includes(s.id)&&h('small',null,selected.includes(s.id)?'已选择开启，尚未保存':'已选择关闭，尚未保存'))),
                h('div',{className:'memory-actions'},h('button',{type:'button',disabled:saving||dirty||(s.unavailable&&!current.includes(s.id)),onClick:()=>saveSessions({action:current.includes(s.id)?'unbind':'bind',value:s.id}),'aria-label':(current.includes(s.id)?'关闭本对话记忆：':'启用本对话记忆：')+s.title},current.includes(s.id)?'关闭本对话记忆':'启用本对话记忆'))))),
            dirty&&h('div',{className:'memory-actions'},h('button',{type:'button',onClick:()=>saveSessions(),disabled:saving},saving?'保存中':'保存对话选择'),h('button',{type:'button',onClick:()=>{setSelected(current);setSessionError('');setSessionNotice('');},disabled:saving},'取消'))),
          saving&&h('p',{className:'memory-notice',role:'status'},'保存中…'),sessionNotice&&h('p',{className:'memory-notice',role:'status'},sessionNotice),sessionError&&h('p',{className:'memory-notice',role:'alert'},sessionError));
      }
      else if(tab==='maintenance')content=h(React.Fragment,null,h('h3',null,'记忆库'),h('p',{className:'note'},'个人记忆库可独立创建或切换。'),sessionInfo&&h('div',{className:'memory-line'},h('span',null,'当前个人记忆库'),h('span',null,sessionInfo.directory)),sessionInfo?.pendingDirectory&&h('div',{className:'memory-line'},h('span',null,'待切换的记忆库'),h('span',null,sessionInfo.pendingDirectory)),sessionInfo?.switchError&&h('p',{className:'memory-notice',role:'status'},'上次未切换：'+sessionInfo.switchError),h('p',{className:'note'},'可创建或选择独立记忆库。选择后当前库继续运行，下次重新加载时检查两边的待处理内容后切换。'),sessionInfo&&h('div',{className:'memory-group-form'},h('label',null,'记忆库路径',h('input',{value:newDirectory,onChange:e=>setNewDirectory(e.target.value),placeholder:'目标目录的完整路径'}))),sessionInfo&&h('div',{className:'memory-actions'},h('button',{type:'button',disabled:creatingLibrary||!newDirectory.trim(),onClick:createLibrary},creatingLibrary?'正在处理，请稍候':'创建新记忆库'),h('button',{type:'button',disabled:creatingLibrary||!newDirectory.trim(),onClick:selectLibrary},'选择此记忆库')),libraryNotice&&h('p',{className:'memory-notice',role:'status'},libraryNotice),sessionError&&h('p',{className:'memory-notice',role:'status'},sessionError));
      else content=h(React.Fragment,null,h('h3',null,'运行状态'),h('div',{className:'memory-line'},h('span',null,'个人记忆服务'),h('span',null,core)),h('div',{className:'memory-line'},h('span',null,'待同步'),h('span',null,sessionInfo?.recovery?`${sessionInfo.recovery.sync} 项`:'暂时无法读取')),sessionInfo?.recovery?.platformHeld>0&&h('p',{className:'note'},`其中 ${sessionInfo.recovery.platformHeld} 项包含暂停的平台来源，暂不自动处理。`),h('div',{className:'memory-actions'},h('button',{type:'button',onClick:refreshStatus},'刷新状态')),sessionError&&h('p',{className:'memory-notice',role:'status'},sessionError));
      if(tab==='maintenance'&&hasSessionMemory(sessionInfo))content=h(React.Fragment,null,content,h(MemoryDocumentSelection));
      if(tab==='status')content=h(React.Fragment,null,content,hasSessionMemory(sessionInfo)&&h(MemoryReviewSettings));
      if(tab==='maintenance')content=h(React.Fragment,null,content,h(MemoryRuntimeSettings,{info:sessionInfo,showVectors:false}));
      if(tab==='basic'&&flagDraft&&sessionInfo){
        const flags=[['autoCapture','交流后自动整理'],['recentContext','短期上下文'],['rawRecall','本地原话检索（首次需配置模型）']];
        flags.unshift(['autoRecall',onDemand?'回答前预先带上相关记忆（最多4条）':'回答前召回事实记忆']);
        const prior=sessionInfo.pendingFlags??sessionInfo.flags,dirty=flags.some(([key])=>flagDraft[key]!==prior[key]);
        content=h(React.Fragment,null,content,h('fieldset',{className:'memory-policy',disabled:savingFlags},
          h('legend',null,'记忆功能'),
          h('p',{className:'note'},onDemand?'对话开启记忆后，模型按需查找记忆。关闭功能不会删除已有记忆，人格档案按自身设置生效。':'关闭功能不会删除已有记忆，人格档案按自身设置生效。'),
          ...flags.map(([key,label])=>h('label',{key},h('input',{type:'checkbox',checked:flagDraft[key],onChange:e=>setFlagDraft({...flagDraft,[key]:e.target.checked})}),label)),
          sessionInfo.pendingFlags&&h('p',{className:'note'},'已有设置等待下次重新加载后生效，当前仍使用之前的设置。'),
          sessionInfo.settingsError&&h('p',{className:'memory-notice',role:'status'},sessionInfo.settingsError),
          dirty&&h('div',{className:'memory-actions'},h('button',{type:'button',onClick:saveFlags},savingFlags?'保存中':'保存记忆功能设置')),
          flagNotice&&h('p',{className:'memory-notice',role:'status'},flagNotice)));
      }
      if(tab==='basic'&&sessionInfo)content=h(React.Fragment,null,content,h(TimeZoneSettings,{info:sessionInfo,onSaved:setSessionInfo}));
      if(tab==='basic'&&hasSessionMemory(sessionInfo))content=h(React.Fragment,null,content,h(HandoffSettings,{revision:sessionInfo.revision,onSaved:refreshStatus}));
      if(tab==='model'&&sessionInfo?.rawModel)content=h(ModelPicker,{info:sessionInfo,onSaved:setSessionInfo});
      if(tab==='maintenance'&&sessionInfo?.rawModel)content=h(React.Fragment,null,content,h('details',{className:'memory-group-options'},h('summary',null,'检索模型的文件、线程与等待时间（专家）'),h(RawModelSettings,{info:sessionInfo,onSaved:setSessionInfo})));
      if(tab==='basic'&&!sessionInfo&&sessionError)content=h(React.Fragment,null,content,h(BootstrapSetup));
      return h('section',{className:'memory-page'},h('h2',null,'记忆框架'),h('p',{className:'summary'},'选择要记住的对话和检索模型；其余在「维护」里'),h('div',{className:'memory-tabs',role:'tablist','aria-label':'记忆设置分类'},...tabs.map(([id,label],i)=>h('button',{key:id,type:'button',role:'tab',id:'memory-tab-'+id,'aria-controls':'memory-tab-panel','aria-selected':tab===id,tabIndex:tab===id?0:-1,onClick:()=>setTab(id),onKeyDown:e=>{if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length][0];setTab(next);document.getElementById('memory-tab-'+next)?.focus();}},label))),h('div',{id:'memory-tab-panel',className:'memory-content',role:'tabpanel','aria-labelledby':'memory-tab-'+tab},content));
    }
    exports.inject=['slots','remote','remote.pluginManager'];
    exports.apply=(ctx)=>{
      ctx.effect(style,'basic-memory: settings style');
      const readStatus=async()=>{
        const isCoreModule=value=>{const normalized=String(value??'').replace(/^file:\/\/\//i,'').replace(/\\/g,'/').toLowerCase(),names=['@local/dsh-basic-memory-bridge','@local/dsh-basic-memory-bridge/bundle-entry','@local/dsh-basic-memory-bridge/platform-host'];return names.includes(normalized)||normalized.endsWith('/dsh-basic-memory-bridge/lib/bundle-entry.js');};
        const plugins=await ctx.remote.pluginManager.listPlugins();
        if(!plugins.ok)throw Error('无法读取 DSH 插件状态');
        // Frozen versions have a different file URI but retain this Include ID.
        const coreEntry=plugins.value.find(p=>p.entryId==='include:basic-memory-bridge');
        const active=p=>p.enabled&&p.fiberPhase==='active';
        const core=coreEntry?active(coreEntry):plugins.value.some(p=>isCoreModule(p.moduleName)&&active(p));
        return {status:'ready',core};
      };
      ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'basic-memory',order:50,label:()=> '记忆框架'},()=>h(Page,{readStatus})));
      ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'basic-memory-session',order:-21},ConversationMemory));
      ctx.slots.inject('conversation.hero.options',()=>ctx.slots.register({name:'conversation.hero.options',id:'basic-memory-session',order:9},ConversationMemory));
    };
    return exports;
  }
});
