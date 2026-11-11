window.__ModuleLoader__.load({
  id:'@local/dsh-basic-memory-bridge',
  factory:(require)=>{
    const React=require('react'),h=React.createElement, exports={};
    const css=`
.memory-page{max-width:720px;padding:24px;color:var(--dsw-alias-label-primary,CanvasText);font:inherit;font-size:13px;line-height:1.5}
.memory-page h2{margin:0 0 12px;font-size:16px;line-height:24px;font-weight:500}
.memory-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:.5px solid var(--dsw-alias-border-l2,ButtonBorder)}
.memory-page .memory-tabs button{height:auto;background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--dsw-alias-label-secondary,GrayText);font-size:14px;padding:8px 12px;white-space:nowrap}
.memory-page .memory-tabs button:hover:not(:disabled){background:transparent;color:var(--dsw-alias-label-primary,CanvasText)}
.memory-page .memory-tabs button[aria-selected=true]{border-bottom-color:var(--dsw-alias-label-primary,CanvasText);color:var(--dsw-alias-label-primary,CanvasText);font-weight:500}
.memory-subtabs{margin-top:4px}.memory-page .memory-subtabs button{font-size:13px;padding:6px 10px}
.memory-content{padding:4px 0 24px}
.memory-group{margin-top:28px}.memory-group:first-child{margin-top:16px}
.memory-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-height:28px}
.memory-group-head h3{margin:0;font-size:15px;line-height:24px;font-weight:600}.memory-group-head .memory-spacer{flex:1}
.memory-field,.memory-row{padding:12px 0}
.memory-field{display:flex;flex-direction:column;align-items:stretch;gap:6px}
.memory-group-head+.memory-field,.memory-group-head+.memory-row{padding-top:8px}
:is(.memory-field,.memory-row)+:is(.memory-field,.memory-row){border-top:.5px solid var(--dsw-alias-border-l2,ButtonBorder)}
.memory-field-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.memory-field-head label,.memory-field-name{font-size:13px;font-weight:500}
.memory-row{display:flex;align-items:center;gap:12px;min-height:24px}
.memory-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.memory-row-main>span:first-child{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.memory-row-value{color:var(--dsw-alias-label-secondary,GrayText);text-align:right;overflow-wrap:anywhere;min-width:0}
.memory-meta,.memory-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere}
.memory-page .memory-help-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l4,ButtonBorder);border-radius:50%;background:none;color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;line-height:1;cursor:pointer}
.memory-page .memory-help-button:hover,.memory-page .memory-help-button[aria-expanded=true]{background:var(--dsw-alias-bg-layer-4,ButtonFace);color:var(--dsw-alias-label-secondary,GrayText)}
.memory-help{flex-basis:100%;margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,GrayText);font-weight:400}
.memory-page :is(input:not([type=checkbox]):not([type=radio]),select,textarea){box-sizing:border-box;width:100%;max-width:440px;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,ButtonBorder);border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3,Field);color:var(--dsw-alias-label-primary,FieldText);font:inherit;font-size:13px}
.memory-page textarea{height:auto;padding:8px 12px}
.memory-page :is(input,select,textarea):focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,Highlight)}
.memory-page :is(input,select,textarea):is(:disabled,[readonly]){color:var(--dsw-alias-label-tertiary,GrayText)}
.memory-page input[type=checkbox]:not([role=switch]),.memory-page input[type=radio]{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-button-primary-fill,AccentColor);cursor:pointer}
.memory-page input[role=switch]{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;margin:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,GrayText);cursor:pointer;transition:background .12s ease}
.memory-page input[role=switch]::before{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,Canvas);transition:transform .12s ease}
.memory-page input[role=switch]:checked{background:var(--dsw-alias-brand-primary,AccentColor)}
.memory-page input[role=switch]:checked::before{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,Canvas)}
.memory-page input[role=switch]:disabled{opacity:.5;cursor:default}
.memory-page input:is([role=switch],[type=checkbox],[type=radio]):focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,Highlight));outline-offset:2px}
.memory-check{display:flex;align-items:flex-start;gap:8px;padding:8px 0;font-size:13px;line-height:1.5;cursor:pointer}
.memory-choice{display:flex;flex-wrap:wrap;gap:4px 16px}.memory-choice label{display:flex;align-items:center;gap:6px;cursor:pointer}.memory-page .memory-choice input[type=radio]{margin:0}
.memory-page button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4,ButtonBorder);border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-primary,ButtonText);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.memory-page button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,ButtonFace)}
.memory-page button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,ButtonFace)}
.memory-page button:disabled{opacity:.4;cursor:not-allowed}
.memory-page button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,Highlight));outline-offset:2px}
.memory-page button.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,AccentColor);color:var(--dsw-alias-label-primary-foreground,AccentColorText)}
.memory-page button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,AccentColor)}
.memory-page button.small{height:26px;padding:0 10px;font-size:12px;border-radius:var(--dsw-radius-sm,4px)}
.memory-page button.danger{color:var(--dsw-alias-state-error-primary,#d33)}
.memory-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}
.memory-row .memory-actions{margin:0;flex:none}
.memory-segment{display:inline-flex;align-self:flex-start;padding:2px;gap:2px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3,ButtonFace)}
.memory-page .memory-segment button{height:26px;border:0;padding:0 12px;font-size:12px;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-secondary,GrayText)}
.memory-page .memory-segment button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-weight:500}
.memory-badge{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-3,ButtonFace);color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;font-weight:500;line-height:18px;white-space:nowrap}
.memory-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.memory-badge.ok{background:var(--dsw-alias-state-success-tertiary,ButtonFace);color:var(--dsw-alias-state-success-primary,green)}
.memory-badge.warn{background:var(--dsw-alias-state-warn-tertiary,ButtonFace);color:var(--dsw-alias-state-warn-label,#b60)}
.memory-badge.error{color:var(--dsw-alias-state-error-primary,#d33)}
.memory-badge.off{color:var(--dsw-alias-state-idle-primary,GrayText)}
.memory-progress{display:inline-block;width:96px;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-4,ButtonFace);overflow:hidden;vertical-align:middle;margin-right:8px}
.memory-progress>span{display:block;height:100%;background:var(--dsw-alias-brand-primary,AccentColor)}
.memory-notice{margin:8px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,GrayText)}
.memory-notice[role=alert]{color:var(--dsw-alias-state-error-primary,#d33)}
.memory-session-list{max-height:320px;overflow-y:auto;margin-top:4px;border-block:.5px solid var(--dsw-alias-border-l2,ButtonBorder)}
.memory-session-list .memory-row{padding:8px 2px}
.memory-service-form{margin:4px 0 8px;padding:4px 12px 12px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-2,ButtonFace)}
.memory-page details{padding:10px 0}.memory-page summary{cursor:pointer;color:var(--dsw-alias-label-secondary,GrayText)}
.memory-page fieldset{min-width:0;margin:0;padding:0;border:0}
.memory-dialog{margin-top:8px;padding:12px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-2,ButtonFace)}
.memory-dialog p{margin:0}
.memory-review-entry{padding:8px 0}.memory-review-entry h4{margin:0 0 4px;font-size:13px;font-weight:600}
.memory-page ul.memory-list{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.memory-page .note{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,GrayText)}
.memory-sessions{margin-top:28px}.memory-sessions h3,.memory-sessions legend{margin:0 0 8px;font-size:15px;font-weight:600}
.memory-group-form{display:flex;flex-direction:column;gap:12px;margin-top:12px}.memory-group-form label{display:flex;flex-direction:column;gap:6px;font-weight:500}
.memory-session{display:flex;align-items:flex-start;gap:8px;padding:6px 0}.memory-session small{display:block;color:var(--dsw-alias-label-tertiary,GrayText)}
.memory-session-toggle{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px}.memory-session-toggle button{background:transparent;border:.5px solid var(--dsw-alias-border-l4,ButtonBorder);border-radius:var(--dsw-radius-md,6px);color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:4px 10px}.memory-session-toggle button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,ButtonFace)}.memory-session-toggle button:disabled{cursor:default;opacity:.4}.memory-session-toggle button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:2px}.memory-session-toggle small{color:var(--dsw-alias-label-tertiary,GrayText)}
@media(max-width:520px){.memory-page{padding:16px}.memory-page .memory-tabs button{padding:8px}.memory-row{flex-wrap:wrap}}
`;
    // Explanations live behind a small "?" next to the label, as on DSH's own settings pages.
    function Help({text,label}){
      const [open,setOpen]=React.useState(false);
      return h(React.Fragment,null,h('button',{type:'button',className:'memory-help-button','aria-label':'说明'+(label?'：'+label:''),title:text,'aria-expanded':open,onClick:()=>setOpen(!open)},'?'),
        open&&h('p',{className:'memory-help'},text));
    }
    const help=(text,label)=>text?h(Help,{text,label}):null;
    const badge=(tone,label)=>h('span',{className:'memory-badge '+tone},label);
    // One settings group: title row (badge, help, extra controls) then fields/rows.
    const group=(title,{badge:mark,help:helpText,extra}={},...children)=>h('section',{className:'memory-group'},
      h('div',{className:'memory-group-head'},h('h3',null,title),helpText&&help(helpText,title),mark,extra&&h('span',{className:'memory-spacer'}),extra),...children);
    // A labelled control: label (+help, +badge) above, the control, then a one-line hint.
    const field=(id,label,control,{help:helpText,hint,mark}={})=>h('div',{className:'memory-field'},
      h('div',{className:'memory-field-head'},h('label',{htmlFor:id},label),helpText&&help(helpText,label),mark),control,hint&&h('p',{className:'memory-hint'},hint));
    // A read-only line: name on the left, value or badge on the right.
    const row=(name,value,{meta,help:helpText}={})=>h('div',{className:'memory-row'},
      h('div',{className:'memory-row-main'},h('span',null,name,helpText&&help(helpText,name)),meta&&h('span',{className:'memory-meta'},meta)),
      h('div',{className:'memory-row-value'},value));
    const progressBar=(done,total)=>Number.isFinite(done)&&Number.isFinite(total)&&total>0?h('span',{className:'memory-progress','aria-hidden':true},h('span',{style:{width:Math.min(100,Math.round(done/total*100))+'%'}})):null;
    const thousands=value=>Number.isFinite(value)?value.toLocaleString('en-US'):'未知';

    function style(){const el=document.createElement('style');el.textContent=css;document.head.appendChild(el);return()=>el.remove();}
    const sessionSettingsPath='/api/basic-memory-settings/sessions',sessionsChanged='basic-memory:sessions-changed';
    const hasSessionMemory=info=>info?.sessionMemory?.defaultEnabled===false&&info.sessionMemory.effective==='next-user-turn'&&Array.isArray(info.sessionMemory.enabledSessions);
    const hasAutoEnableNew=info=>hasSessionMemory(info)&&typeof info.sessionMemory.autoEnableNew==='boolean';
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
    function ModelPreparation({info,draft,onPrepared,onDownloaded,onRunning,installed=null,downloadBytes=0}){
      const [job,setJob]=React.useState(null),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[acceleration,setAcceleration]=React.useState(draft.rawRecallDevice==='cpu'?'cpu':/Embedding-(?:4B|8B)$/.test(draft.rawRecallModel)?'cuda':'cpu');
      const draftRef=React.useRef(draft),downloadedRef=React.useRef('');draftRef.current=draft;
      React.useEffect(()=>{onRunning(job?.state==='running');return()=>onRunning(false);},[job?.state,onRunning]);
      const refresh=async()=>{const response=await fetch('/api/basic-memory-settings/sessions',{credentials:'same-origin'}),value=await response.json();if(response.ok&&value.ok)onPrepared(value);};
      const request=async input=>{const response=await fetch('/api/basic-memory-settings/model-install',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,settings:draftRef.current,acceleration,...input})});const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error || '准备未完成');return value;};
      React.useEffect(()=>{setNotice('');},[draft.rawRecallModel,acceleration]);
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
      const running=job?.state==='running';
      const size=bytes=>(bytes/1024/1024).toFixed(bytes>1024**3?0:1)+' MB';
      // Simple view (model tab): download files only, then enable through the normal save flow.
      return h('div',null,
        installed===false&&!running&&h('div',{className:'memory-actions'},h('button',{type:'button',className:'primary',disabled:busy,onClick:()=>act({action:'start',allowDownload:true,downloadOnly:true})},'下载')),
        installed===false&&!running&&h('p',{className:'memory-hint'},'尚未下载（约 '+size(downloadBytes)+'）。下载只保存文件，不切换模型。'),
        job&&(running||job.model===draft.rawRecallModel)&&h('p',{className:'memory-notice',role:'status'},job.step+(running&&job.total?'（'+size(job.received)+' / '+size(job.total)+'）':'')+(job.error?'；'+job.error:'')),
        running&&h('button',{type:'button',disabled:busy,onClick:()=>act({action:'cancel',id:job.id})},'取消'),
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
    const rawModelName=(info,fields)=>{
      const id=fields?.rawRecallModel;
      if(id==='custom-api')return fields?.rawRecallApiModel||id;
      return info?.rawModels?.find(model=>model.id===id)?.label??id??'未报告';
    };
    function MemoryRuntimeSettings({info,modelId,cloud=false,dirty=false,showVectors=true,tick=0}){
      const [state,setState]=React.useState(()=>info?.memoryRuntime??(info?.runtime&&typeof info.runtime==='object'?info.runtime:null)),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[batchId,setBatchId]=React.useState('');
      const [legacyId,setLegacyId]=React.useState('');
      const alive=React.useRef(false),request=React.useRef(0),acting=React.useRef(false);
      const refresh=React.useCallback(async()=>{
        const ticket=++request.current;
        try{const value=await memoryRuntime();if(alive.current&&ticket===request.current){setState(value);setError('');}}
        catch(cause){if(alive.current&&ticket===request.current){setError(cause.message);setState(null);}}
      },[]);
      React.useEffect(()=>{alive.current=true;refresh();return()=>{alive.current=false;request.current++;};},[refresh,info?.revision,tick]);
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
      const rerank=state?.rerank;
      async function act(action){
        if(acting.current)return;acting.current=true;setBusy(true);setError('');setNotice('');request.current++;
        const vectorAction=['load','release','prepare','resume-prepare','cancel'].includes(action);
        const actionProfile=action==='cancel'&&operating&&operation.profileId
          ?{id:operation.profileId,revision:operation.profileRevision}:{id:target,revision:profile?.revision};
        const input={action,...(vectorAction?{profileId:actionProfile.id,...(actionProfile.revision!==undefined?{profileRevision:actionProfile.revision}:{})}:action==='retry'?{batchId}:action==='legacy-recover'?{sessionId:legacyId}:{})};
        if(action==='resume-prepare')input.intentId=progress.intentId;
        try{
          const result=await memoryRuntime(input);
          if(alive.current)setNotice(result.started?'操作已启动，进度见上方。':action==='cancel'?'取消请求已返回。':'操作已提交。');
          if(alive.current)await refresh();
        }catch(cause){if(alive.current){setError(cause.message);await refresh();setError(cause.message);}}
        finally{acting.current=false;if(alive.current)setBusy(false);}
      }
      const modelBusy=['loading','releasing'].includes(modelState)||progress?.state==='preparing';
      const modelName=rawModelName(info,{rawRecallModel:modelId,rawRecallApiModel:info?.rawModel?.fields?.rawRecallApiModel});
      const modelTone={loaded:'ok',ready:'ok',loading:'warn',releasing:'warn',preparing:'warn',error:'error',failed:'error',unavailable:'error'}[modelState]??'off';
      const indexBadge=!progress?badge('off','未建立'):progress.pendingBoundaries?badge('warn','待追平'):progress.state==='ready'?badge('ok','已就绪'):
        progress.state==='preparing'?badge('warn','建索引中'):progress.state==='error'?badge('error','出错'):badge('off',runtimeStateLabel(progress.state));
      const indexMeta=[progress?.pendingBoundaries&&'有新内容待补进索引',progress?.error&&errorLabel(progress.error),
        !progress&&(cloud?'点「准备索引」建立；云端模型会按量计费':'点「准备索引」建立')].filter(Boolean).join('；')||undefined;
      // Rerank settings are read when DSH starts; a later save waits for the next restart.
      const rerankRunning=Boolean(rerank?.enabled&&rerank.state!=='off'),rerankSaved=info?.rerank?.enabled;
      const rerankPending=rerank&&typeof rerankSaved==='boolean'&&rerankSaved!==rerankRunning;
      const rerankValue=!rerank?badge('off','未接入'):rerankPending?badge('warn',rerankSaved?'重启后开启':'重启后关闭'):
        rerank.state==='paused'?badge('warn','暂停中'):rerank.state==='unavailable'?badge('error','不可用'):
        !rerankRunning?badge('off','关闭'):badge('ok','已开启');
      const rerankMeta=rerankPending?'已保存，重启 DSH 后生效':!rerankRunning?undefined:['paused','unavailable'].includes(rerank.state)?rerank.reason||'原因未报告':
        rerank.model+' · '+(rerank.service||'主机未报告')+' · 本次启动调用 '+thousands(rerank.calls)+' 次，失败 '+thousands(rerank.failures)+' 次';
      const usage=profile?.embeddingUsage;
      const pipelineBadge=!pipeline?badge('off','未接入'):pipeline.enabled===false?badge('off','未启用'):pipeline.busy?badge('warn','处理中'):badge('ok','空闲');
      const pipelineMeta=pipeline?['待处理 '+count(pipeline.pending),'运行中 '+count(pipeline.running),'已完成 '+count(pipeline.completed),
        pipeline.held>0&&'暂停 '+count(pipeline.held),pipeline.deliveryPending>0&&'待投递 '+count(pipeline.deliveryPending)].filter(Boolean).join(' · '):undefined;
      const disabledReason=dirty?'请先保存设置':operating?'另一项操作正在进行':modelBusy?'模型正在加载或建索引':!profile?'当前模型尚未接入':'';
      const vectorButton=(action,label,primary=false)=>h('button',{type:'button',className:primary?'primary':undefined,disabled:busy||operating||dirty||!profile||modelBusy,title:disabledReason,onClick:()=>act(action)},label);
      return h(React.Fragment,null,
        showVectors&&group('检索',{help:'按意思查找原话和记忆用的向量模型。模型「已加载」和索引「已就绪」分别计算。'},
          row('当前模型',badge(modelTone,runtimeStateLabel(modelState)),{meta:modelName}),
          vectors?.selectedProfileId&&vectors.selectedProfileId!==vectors.activeProfileId&&row('待切换到',vectors.selectedProfileId),
          !cloud&&row('运行设备',actualDevice?deviceLabel(actualDevice):modelState==='unloaded'||modelState==='released'?'未加载':'未报告',
            {meta:[fallbackReason&&'回退原因：'+fallbackReason,Number.isFinite(runtime?.idleReleaseMs)&&(runtime.idleReleaseMs===0?'常驻':'空闲 '+runtime.idleReleaseMs/1000+' 秒后释放'),
              runtime?.runtime?.threads!==undefined&&runtime.runtime.threads+' 线程'].filter(Boolean).join(' · ')||undefined}),
          row('索引',h(React.Fragment,null,progress&&progressBar(progress.completed,progress.total),progress&&h('span',null,count(progress.completed)+' / '+count(progress.total)+' '),indexBadge),{meta:indexMeta}),
          usage&&row('用量',thousands(usage.calls)+' 次 · '+thousands(usage.reportedTokens)+' tokens',{meta:usage.unknownUsageCalls>0?thousands(usage.unknownUsageCalls)+' 次未报告用量':undefined}),
          row('重排',rerankValue,{meta:rerankMeta}),
          info?.rawRecall?.stats&&!vectors&&row('旧原话索引',count(info.rawRecall.stats.indexedWindows)+' / '+count(info.rawRecall.stats.eligibleWindows)+' 个片段'),
          !vectors&&h('p',{className:'memory-hint'},'统一向量状态尚未接入。'),
          profile?.modelError&&h('p',{className:'memory-notice',role:'alert'},'模型错误：'+(profile.modelError.message??profile.modelError.code??String(profile.modelError))),
          h('div',{className:'memory-actions'},
            (modelState==='loading'||progress?.state==='preparing'||operating&&['load','prepare','resume-prepare'].includes(operation.action))&&h('button',{type:'button',disabled:busy,onClick:()=>act('cancel')},'取消向量操作'),
            !cloud&&vectorButton('release','释放运行资源'),
            !cloud&&vectorButton('load','加载／预热'),
            progress?.intentId&&['preparing','paused','error'].includes(progress.state)&&h('button',{type:'button',disabled:busy||operating||dirty,onClick:()=>act('resume-prepare')},'续建原索引'),
            vectorButton('prepare','准备索引',progress?.state!=='ready')),
          dirty&&h('p',{className:'memory-hint'},'设置尚未保存；保存后再加载或准备索引。')),
        group('后台整理',{help:'整理在后台进行。每次操作仍会检查原对话的授权和前台是否占用，所以点了不等于已经整理完。「暂停」是需要人工处理的批次。'},
          row('状态',pipelineBadge,{meta:pipelineMeta}),
          pipeline?.waitingReason&&row('等待原因',pipeline.waitingReason),
          priority&&row('最近优先整理',({remember:'记住',correction:'更正',decision:'决定'}[priority.kind]??'用户请求')+' · '+
            (priority.state==='committed'?'已应用 '+count(priority.applied)+' 项，送审 '+count(priority.reviews)+' 项':runtimeStateLabel(priority.state))),
          h('div',{className:'memory-actions'},
            h('button',{type:'button',disabled:busy||operating||!pipeline||pipeline.enabled===false,onClick:()=>act('resume')},'恢复后台任务'),
            h('button',{type:'button',disabled:busy||operating||!pipeline||pipeline.enabled===false,onClick:()=>act('flush')},'尝试整理待办')),
          state?.legacy?.length>0&&h('details',null,h('summary',null,'旧任务接续'),
            h('label',{className:'memory-field'},'旧任务原会话',h('select',{value:legacyId,disabled:busy||operating,onChange:event=>setLegacyId(event.target.value)},
              h('option',{value:''},'选择原会话'),...state.legacy.map(row=>h('option',{key:row.sessionId,value:row.sessionId},
                `${info?.sessions?.find(session=>session.id===row.sessionId)?.title??row.sessionId} · 整理 ${row.capture} · 同步 ${row.maintenance}`)))),
            h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||operating||!state.legacy.some(row=>row.sessionId===legacyId),onClick:()=>act('legacy-recover')},'恢复所选会话的旧任务'))),
          operation?.receipt&&h('p',{className:'memory-notice',role:'status'},`旧任务已恢复 ${operation.receipt.resumed.length} 项，暂停 ${operation.receipt.held.length} 项。${[...new Set(operation.receipt.held.map(item=>item.reason))].join('、')}`),
          batches.length>0&&h('details',null,h('summary',null,'暂停与失败的批次'),
            h('label',{className:'memory-field'},'重试批次',h('select',{'aria-label':'重试批次',value:batchId,disabled:busy||operating,onChange:event=>setBatchId(event.target.value)},h('option',{value:''},'选择批次'),...batches.map(row=>h('option',{key:row.id,value:row.id},row.id+' · '+runtimeStateLabel(row.state)+(row.error?' · '+row.error:''))))),
            h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy||operating||!batches.some(row=>row.id===batchId),onClick:()=>act('retry')},'重试所选批次')))),
        operation&&h('p',{className:'memory-notice',role:'status'},operationLabel(operation.action)+'：'+runtimeStateLabel(operation.state)+(operation.error?'（'+errorLabel(operation.error)+'）':'')),
        busy&&h('p',{className:'memory-notice',role:'status'},'正在提交操作…'),
        notice&&h('p',{className:'memory-notice',role:'status'},notice),error&&h('p',{className:'memory-notice',role:'alert'},error));
    }
    function ModelSwitch({info,modelId}){
      const [state,setState]=React.useState(null),[plan,setPlan]=React.useState(null),[confirming,setConfirming]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      const load=React.useCallback(async()=>{try{
        const value=await memoryRuntime(),found=value.vectors?.profiles?.find(row=>row.id===modelId||row.model===modelId);setState(value);
        setPlan(found?(await memoryRuntime({action:'plan',profileId:found.id})).plan:null);
      }catch(cause){setNotice(cause.message);}},[modelId,info?.revision]);
      React.useEffect(()=>{setConfirming('');load();},[load]);
      React.useEffect(()=>{if(state?.operation?.state!=='running')return;const timer=setInterval(load,2000);return()=>clearInterval(timer);},[state?.operation?.state,load]);
      const vectors=state?.vectors;if(!vectors)return notice?h('p',{className:'memory-notice',role:'status'},notice):null;
      const profile=vectors.profiles?.find(row=>row.id===modelId||row.model===modelId),progress=profile?.progress,intent=vectors.switchIntent;
      const mine=Boolean(profile&&intent?.profileId===profile.id),active=Boolean(profile&&vectors.activeProfileId===profile.id&&vectors.active?.revision===profile.revision);
      const pendingText=plan?.pending>0?'需补 '+plan.pending+' 篇':'';
      const status=mine&&progress?.state==='preparing'?'切换中 '+(progress.completed??0)+' / '+(progress.total??'?')+'。期间向量检索暂不可用，文字与条目检索正常'
        :mine&&['paused','cancelled'].includes(progress?.state)?'已暂停，下次启动自动续建'
        :mine&&progress?.state==='error'?'出错：'+(errorLabel(progress.error)??'未知原因')
        :active?'使用中'+(pendingText?'，'+pendingText:'')
        :profile?.index?.hasSnapshot?(pendingText?'可切回，'+pendingText:'可立即切回')
        :'未建索引'+(plan?'，需编码 '+plan.pending+' 篇':'');
      const run=async(work,done)=>{setBusy(true);setNotice('');try{await work();setConfirming('');setNotice(done);await load();}catch(cause){setNotice(cause.message);}finally{setBusy(false);}};
      const tone=mine&&progress?.state==='error'?'error':mine||active&&pendingText?'warn':active?'ok':'off';
      return h('div',{'aria-label':'切换向量模型'},
        row('此模型',badge(tone,status)),
        h('div',{className:'memory-actions'},
          profile?.index?.hasSnapshot&&!active&&!mine&&progress?.state!=='preparing'&&h('button',{type:'button',className:'danger',disabled:busy||Boolean(confirming),onClick:()=>setConfirming('drop')},'清理此模型的索引'),
          mine&&h('button',{type:'button',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'cancel-switch'}),'已取消切换；当前模型不变。')},'取消切换'),
          mine&&progress?.state==='error'&&h('button',{type:'button',className:'primary',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'switch',profileId:profile.id,cloudConfirmed:intent.cloudConfirmed===true}),'已重新开始准备。')},'重试')),
        confirming==='drop'&&h('div',{className:'memory-dialog',role:'dialog','aria-label':'确认清理索引'},
          h('p',null,'将删除此模型已建好的索引，不影响原话、条目和当前使用的模型。下次切回需全量重建。'),
          h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>setConfirming('')},'返回'),h('button',{type:'button',className:'danger',disabled:busy,onClick:()=>run(()=>memoryRuntime({action:'drop-index',profileId:profile.id}),'已清理此模型的索引。')},'确认清理'))),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    function RawModelSettings({info,onSaved}){
      const [draft,setDraft]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[expert,setExpert]=React.useState(false);
      const withDefaults=fields=>fields?{rawRecallDevice:'auto',rawRecallCpuThreads:6,rawRecallGpuThreads:4,rawRecallLlamaCpuServer:'',rawRecallLlamaCudaServer:'',rawRecallIdleMs:0,rawRecallQueryWaitMs:0,...fields}:null;
      React.useEffect(()=>{setDraft(withDefaults((info.pendingRawModel??info.rawModel)?.fields));},[info.revision]);
      if(!draft||!info.rawModels)return null;
      const selected=info.rawModels.find(model=>model.id===draft.rawRecallModel),cloud=Boolean(selected?.cloud);
      const previous=withDefaults((info.pendingRawModel??info.rawModel).fields);
      const dirty=JSON.stringify(previous)!==JSON.stringify(draft);
      const update=(name,value)=>setDraft(current=>({...current,[name]:value,
        ...['rawRecallPython','rawRecallCacheDir','rawRecallBgeModelDir','rawRecallOnnxModel','rawRecallOnnxTokenizer','rawRecallGgufModel','rawRecallLlamaServer','rawRecallLlamaCpuServer','rawRecallLlamaCudaServer'].includes(name)?{rawRecallInstallReceipt:''}:{}}));
      const save=async cancel=>{setBusy(true);setNotice('');try{
        const response=await fetch('/api/basic-memory-settings/model',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,...(cancel?{cancel:true}:{settings:draft})})});
        const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');onSaved(value);
        setNotice(cancel?'已取消待切换的模型。':'已保存。保存不会启动模型。');
      }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}};
      const field=(name,label,type='text')=>h('label',{key:name,className:'memory-field'},label,h('input',{type,value:draft[name]??'',onChange:event=>update(name,type==='number'?Number(event.target.value):event.target.value)}));
      const localFields=selected?.engine==='fastembed'?[['rawRecallPython','Python 程序'],['rawRecallCacheDir','已有模型缓存目录'],['rawRecallBgeModelDir','已有 BGE 快照目录（可留空）']]
        :selected?.engine==='onnx'?[['rawRecallPython','Python 程序'],['rawRecallOnnxModel','0.6B ONNX 模型文件'],['rawRecallOnnxTokenizer','tokenizer.json 文件']]
        :[['rawRecallGgufModel','GGUF 模型文件'],['rawRecallLlamaCpuServer','CPU llama-server 程序'],['rawRecallLlamaCudaServer','CUDA llama-server 程序'],['rawRecallLlamaServer','兼容旧版 llama-server 路径']];
      const timeoutHelp='单次编码超时限制一次向量请求；检索总等待限制 memory_search 的整条链路。';
      return h('fieldset',{disabled:busy},group('向量模型（专家）',{help:'这里调整文件路径、线程和等待时间。'+timeoutHelp},
        row('当前模型',selected?.label??draft.rawRecallModel,{meta:'更换模型请到「检索模型」页。'}),
        h('div',{className:'memory-field'},h('div',{className:'memory-segment',role:'group','aria-label':'模型设置模式'},
          h('button',{type:'button','aria-pressed':!expert,onClick:()=>setExpert(false)},'标准模式'),h('button',{type:'button','aria-pressed':expert,onClick:()=>setExpert(true)},'专家模式'))),
        cloud?h('details',{open:expert},h('summary',null,'云端参数'),
          field('rawRecallApiKeyEnv','API Key 环境变量（可选）'),field('rawRecallTimeoutMs','单次编码超时（毫秒）','number'),field('rawRecallQueryWaitMs','检索总等待（毫秒，0 为自动）','number'))
        :h(React.Fragment,null,
          selected?.engine==='llamacpp'?h('label',{className:'memory-field'},'运行设备',h('select',{'aria-label':'运行设备',value:draft.rawRecallDevice,onChange:event=>update('rawRecallDevice',event.target.value)},h('option',{value:'auto'},'自动（优先 GPU）'),h('option',{value:'cpu'},'CPU'),h('option',{value:'cuda'},'GPU（NVIDIA CUDA）')),
            h('span',{className:'memory-hint'},(draft.rawRecallModel==='Qwen/Qwen3-Embedding-4B'?'4B 默认优先 GPU，CPU 备用 6 线程。':'')+'按需加载，空闲后释放。'+(draft.rawRecallDevice!==previous.rawRecallDevice?'已设置：'+deviceLabel(previous.rawRecallDevice)+'。':''))):row('运行设备','CPU',{meta:'此模型只用 CPU。'}),
          h('details',{open:expert},h('summary',null,'高级设置：已有文件与资源'),...localFields.map(([name,label])=>field(name,label)),
            ...(selected?.engine==='llamacpp'?[field('rawRecallCpuThreads','4B CPU 备用线程数','number'),field('rawRecallGpuThreads','GPU 辅助 CPU 线程数','number')]:[field('rawRecallThreads','CPU 线程数（兼容设置）','number')]),field('rawRecallTimeoutMs','单次编码超时（毫秒）','number'),field('rawRecallQueryWaitMs','检索总等待（毫秒，0 为自动）','number'),
            h('label',{className:'memory-field'},'空闲后多少分钟释放模型（0 为常驻）',h('input',{type:'number',min:0,max:60,value:draft.rawRecallIdleMs/60000,onChange:event=>update('rawRecallIdleMs',Math.round(Number(event.target.value)*60000))})),
            selected?.engine==='llamacpp'&&field('rawRecallThreads','其他 GGUF 型号 CPU 线程数（兼容设置）','number'))),
        info.pendingRawModel&&h('p',{className:'memory-notice',role:'status'},'已有模型选择等待重新加载，当前仍用之前的模型。'),
        info.rawRecall?.embeddingUsage?.calls>0&&row('云端向量用量',thousands(info.rawRecall.embeddingUsage.calls)+' 次 · '+thousands(info.rawRecall.embeddingUsage.reportedTokens)+' tokens',
          {meta:(info.rawRecall.embeddingUsage.unknownUsageCalls>0?thousands(info.rawRecall.embeddingUsage.unknownUsageCalls)+' 次未报告用量；':'')+'不含作答模型费用'}),
        info.rawRecall?.backend?.cloudPaused&&h('p',{className:'memory-notice',role:'alert'},'云端检索调用失败后已暂停，避免重复计费；检查 API 设置后重新加载可重试。文字检索不受影响。'),
        h('div',{className:'memory-actions'},info.pendingRawModel&&h('button',{type:'button',disabled:busy,onClick:()=>save(true)},'取消待切换'),
          h('button',{type:'button',className:'primary',disabled:busy||!dirty,title:dirty?'':'没有修改',onClick:()=>save(false)},busy?'保存中':'应用运行设置')),
        h(ModelSwitch,{info,modelId:draft.rawRecallModel,key:'switch'}),
        notice&&h('p',{className:'memory-notice',role:'status'},notice)));
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
      return h('fieldset',{disabled:busy},group('短期接续',{help:'切换对话、连接变化或上次回答未完成时，带上一段最近的聊天，只用一次；连续正常聊天时保留已注入内容。K = 1024 tokens，最多 16K，按估算计量；保留越多，模型输入消耗越多。',
          badge:info.activeTokens!==info.tokens?badge('warn','重新加载后生效'):null},
        h('label',{className:'memory-field'},'注入长度',h('select',{'aria-label':'短期接续长度',value:choice,onChange:event=>setChoice(event.target.value)},
          h('option',{value:'4096'},'4K（推荐）'),h('option',{value:'8192'},'8K（保留更多）'),h('option',{value:'custom'},'自定义'))),
        choice==='custom'&&h('label',{className:'memory-field'},'tokens',h('input',{'aria-label':'自定义接续 tokens',type:'number',min:1,max:16384,step:1,value:custom,onChange:event=>setCustom(event.target.value)}),
          !valid&&h('span',{className:'memory-hint',role:'status'},'请输入 1–16384 的整数。')),
        h('div',{className:'memory-actions'},h('button',{type:'button',className:'primary',disabled:!valid||tokens===info.tokens,title:tokens===info.tokens?'没有修改':'',onClick:save},busy?'正在保存':'保存接续长度')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice)));
    }
    const COMMON_TIME_ZONES=[['Asia/Shanghai','北京时间'],['Asia/Hong_Kong','香港'],['Asia/Taipei','台北'],['Asia/Tokyo','东京'],['Asia/Seoul','首尔'],
      ['Asia/Singapore','新加坡'],['Asia/Bangkok','曼谷'],['Asia/Kolkata','印度'],['Asia/Dubai','迪拜'],['Europe/London','伦敦'],['Europe/Paris','巴黎'],
      ['Europe/Berlin','柏林'],['Europe/Moscow','莫斯科'],['America/New_York','纽约'],['America/Chicago','芝加哥'],['America/Denver','丹佛'],
      ['America/Los_Angeles','洛杉矶'],['America/Vancouver','温哥华'],['America/Toronto','多伦多'],['America/Sao_Paulo','圣保罗'],
      ['Australia/Sydney','悉尼'],['Pacific/Auckland','奥克兰'],['UTC','协调世界时']];
    // Offset now, e.g. "UTC+8"; the browser decides daylight saving.
    const zoneOffset=zone=>{try{const part=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'shortOffset'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName')?.value;return part?part.replace(/^GMT/,'UTC').replace(/^UTC$/,'UTC+0'):'';}catch{return '';}};
    const allTimeZones=()=>{try{return Intl.supportedValuesOf?.('timeZone')??[];}catch{return [];}};
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
          onSaved?.(result);setNotice('已保存，重新加载记忆框架后生效。');
        }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}
      };
      return h('fieldset',{disabled:busy},group('时区',{badge:badge(info.timeZone!==active?'warn':'ok',active||'未报告'),
          help:'记忆里的时间按这个时区记录。默认北京时间；人在其他地区时选当地时区。'},
        h('label',{className:'memory-field'},'个人时区',h('select',{'aria-label':'个人时区',value:draft,onChange:event=>setDraft(event.target.value)},
            h('option',{value:''},'默认（北京时间）'),
            h('optgroup',{label:'常用'},...COMMON_TIME_ZONES.map(([zone,name])=>h('option',{key:zone,value:zone},name+'　'+zoneOffset(zone)+' · '+zone))),
            (()=>{const common=new Set(COMMON_TIME_ZONES.map(([zone])=>zone)),rest=allTimeZones().filter(zone=>!common.has(zone));
              // Keep a saved zone selectable even when this browser does not list it.
              if(saved&&!common.has(saved)&&!rest.includes(saved))rest.unshift(saved);
              return rest.length?h('optgroup',{label:'全部时区'},...rest.map(zone=>h('option',{key:zone,value:zone},zone+'　'+zoneOffset(zone)))):null;})()),
          h('span',{className:'memory-hint'},'当前生效：'+(active||'未报告')+'；本机时区：'+(info.timeZoneHost||'未报告'))),
        info.timeZoneError&&h('p',{className:'memory-notice',role:'alert'},info.timeZoneError),
        info.activeTimeZoneError&&info.activeTimeZoneError!==info.timeZoneError&&h('p',{className:'memory-notice',role:'alert'},info.activeTimeZoneError),
        info.timeZone!==active&&h('p',{className:'memory-hint'},'已保存的时区重新加载后生效。'),
        h('div',{className:'memory-actions'},h('button',{type:'button',className:'primary',disabled:!dirty,title:dirty?'':'没有修改',onClick:save},busy?'正在保存':'保存时区')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice)));
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
      const details=(label,entry)=>h('section',{className:'memory-review-entry'},h('h4',null,label),entry?
        h(React.Fragment,null,h('p',{className:'memory-meta'},[entry.type,entry.state?.validity,entry.state?.progress].filter(Boolean).join(' · ')),
          h('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},entry.content),
          entry.importance&&h('p',{className:'memory-meta'},`重要程度 ${entry.importance.level} · ${entry.importance.reason}`),
          entry.tags?.length?h('p',{className:'memory-meta'},entry.tags.join('、')):null):h('p',{className:'memory-hint'},'当前版本或原文依据已不可用。'));
      return group('人工审核',{help:'对照记忆库里的当前条目和整理建议。接受后保存旧版本，拒绝后保留当前条目。',
          extra:h('button',{type:'button',className:'small',disabled:busy,onClick:()=>run(signal=>listPage(signal))},list?'刷新审核列表':'读取待审核')},
        list&&!list.items.length&&h('p',{className:'memory-hint'},'暂无待审核建议。'),
        list&&list.items.length>0&&h('ul',{className:'memory-list'},...list.items.map(item=>h('li',{key:item.operationId},
          h('button',{type:'button',className:'small',disabled:busy,onClick:()=>run(signal=>show(item.operationId,signal))},`${item.type} · ${reasons[item.reason]??'核对当前版本'}`)))),
        list?.nextAfter&&h('div',{className:'memory-actions'},h('button',{type:'button',className:'small',disabled:busy,onClick:()=>run(signal=>listPage(signal,list.nextAfter))},'加载更多建议')),
        selected&&h(React.Fragment,null,details('当前条目',selected.current),details('整理建议',selected.proposed),
          selected.sources.length>0&&h('details',null,h('summary',null,'查看原文依据'),
            ...selected.sources.map(source=>h('p',{key:source.id+':'+source.revision,style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},
              `${source.role==='user'?'用户':'助手'} · ${source.text}`))),
          h('div',{className:'memory-actions'},
            h('button',{type:'button',disabled:busy,onClick:()=>setSelected(null)},'关闭对照'),
            h('button',{type:'button',disabled:busy,onClick:()=>run(signal=>show(selected.operationId,signal))},'刷新当前条目'),
            h('button',{type:'button',disabled:busy||!selected.canReject,onClick:()=>decide('reject')},'拒绝建议'),
            h('button',{type:'button',className:'primary',disabled:busy||!selected.canApprove,onClick:()=>decide('approve')},selected.submitted?'核对提交结果':'接受建议'))),
        busy&&h('p',{className:'memory-notice',role:'status'},'正在处理…'),notice&&h('p',{className:'memory-notice',role:'status'},notice));
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
          if(save)setNotice('已保存资料选择，索引进度见「状态」页。');
        }catch(error){setNotice(error.message);}finally{setBusy(false);}
      }
      const dirty=current&&JSON.stringify(identifiers)!==JSON.stringify(current.identifiers);
      return group('手选检索资料',{help:'让检索也能查到记忆库里指定的 Markdown 文件：每行填一个相对路径。删除某行并保存即可撤回。',
          extra:h('button',{type:'button',className:'small',disabled:busy,onClick:()=>load(false)},current?'刷新所选资料':'读取所选资料')},
        current&&h('label',{className:'memory-field'},'资料相对路径',h('textarea',{value:draft,rows:5,disabled:busy,onChange:e=>setDraft(e.target.value)})),
        current&&h('div',{className:'memory-actions'},h('button',{type:'button',className:'primary',disabled:busy||!dirty,title:dirty?'':'没有修改',onClick:()=>load(true)},'保存资料选择')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
    }
    // One model chosen from a list; files, threads and timeouts are managed by the installer (expert view in 维护).
    const TIER_INFO={light:['轻量','CPU 运行，占用约几百 MB 内存'],balanced:['均衡','CPU 运行，占用约 1 GB 内存'],quality:['高质量','优先用显卡，约 3 GB 显存；无显卡时用 CPU'],
      advanced:['高级','优先用显卡，约 5–6 GB 显存'],cloud:['云端','不占本机资源；检索内容发送到云端，按量收费']};
    const modelTitle=model=>{const tier=(TIER_INFO[model.tier??(model.cloud?'cloud':'')]??[''])[0];return (tier?tier+' · ':'')+model.label.split(' · ')[0].replace(/^云端\s+/u,'');};
    function RerankSettings({info,onSaved}){
      const [draft,setDraft]=React.useState(null),[confirmed,setConfirmed]=React.useState(false),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
      React.useEffect(()=>{
        const saved=info.rerank??{};
        setDraft({enabled:saved.enabled===true,source:saved.source==='direct'?'direct':'service',serviceId:saved.serviceId??'',
          apiBase:saved.apiBase??'',apiKey:'',model:saved.model??'BAAI/bge-reranker-v2-m3',candidates:saved.candidates??30});
        setConfirmed(false);setNotice('');
      },[info.revision]);
      if(!draft)return null;
      const services=(info.embeddingServices??[]).filter(service=>service.hasKey===true),source=draft.source==='direct'?'direct':'service';
      const candidates=Number(draft.candidates),validCandidates=Number.isInteger(candidates)&&candidates>=5&&candidates<=50;
      const validModel=typeof draft.model==='string'&&draft.model.trim().length>0&&draft.model.trim().length<=120;
      const validBase=source!=='direct'||Boolean(String(draft.apiBase??'').trim());
      const canSave=validModel&&validCandidates&&validBase&&(!draft.enabled||confirmed&&(source==='direct'||Boolean(draft.serviceId)));
      const change=(name,value)=>setDraft(current=>({...current,[name]:value}));
      const changeSource=value=>{change('source',value);setConfirmed(false);setNotice('');};
      const save=async()=>{
        if(!canSave||busy)return;
        setBusy(true);setNotice('');
        try{
          const response=await fetch('/api/basic-memory-settings/rerank',{method:'POST',credentials:'same-origin',
            headers:{'content-type':'application/json','x-basic-memory-settings':'1'},
            body:JSON.stringify({enabled:draft.enabled,source,serviceId:source==='service'?draft.serviceId:'',
              ...(source==='direct'?{apiBase:draft.apiBase.trim(),...(draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{})}:{}),
              model:draft.model.trim(),candidates,...(draft.enabled?{cloudConfirmed:confirmed}:{}),revision:info.revision})});
          const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'重排设置保存失败');
          onSaved?.({...info,rerank:value.rerank,revision:value.revision});
          setDraft(current=>({...current,apiKey:''}));
          setNotice('已保存。重启 DSH 后生效。');
        }catch(error){setNotice(error.message||'重排设置保存失败');}
        finally{setBusy(false);}
      };
      const saved=info.rerank??{};
      const disabledReason=!validModel?'请填写重排模型':!validCandidates?'候选数应为 5–50':!validBase?'请填写服务地址':draft.enabled&&!confirmed?'请先勾选确认':draft.enabled&&source==='service'&&!draft.serviceId?'请选择服务':'';
      return h('fieldset',{disabled:busy},group('重排（可选）',{badge:saved.enabled?badge('ok','已开启'):badge('off','关闭'),
          help:'检索先找出一批候选，再交给重排模型按相关度重新排序，排在前面的更准。默认关闭；失败或超时会沿用原来的顺序。保存后重启 DSH 生效。'},
        h('div',{className:'memory-row'},h('div',{className:'memory-row-main'},h('span',null,h('label',{htmlFor:'memory-rerank-enabled'},'启用重排'))),
          h('input',{id:'memory-rerank-enabled',type:'checkbox',role:'switch',checked:draft.enabled,disabled:busy,
            onChange:event=>{change('enabled',event.target.checked);setConfirmed(false);setNotice('');}})),
        h('div',{className:'memory-field'},h('span',{className:'memory-field-name'},'服务'),
          h('div',{className:'memory-choice',role:'radiogroup','aria-label':'重排服务来源'},
            h('label',null,h('input',{type:'radio',name:'rerank-source',value:'service',checked:source==='service',disabled:busy,onChange:()=>changeSource('service')}),'使用已保存的服务'),
            h('label',null,h('input',{type:'radio',name:'rerank-source',value:'direct',checked:source==='direct',disabled:busy,onChange:()=>changeSource('direct')}),'单独填写地址和 Key'))),
        source==='service'?h('label',{className:'memory-field'},'已保存的服务',h('select',{'aria-label':'重排服务',value:draft.serviceId,disabled:busy||!services.length,
            onChange:event=>change('serviceId',event.target.value)},
            h('option',{value:''},services.length?'选择已保存的服务':'请先保存带密钥的服务'),
            ...services.map(service=>h('option',{key:service.id,value:service.id},service.name))),
          !services.length&&h('span',{className:'memory-hint'},'先在「向量」里保存一个带 API Key 的服务。'))
        :h(React.Fragment,null,
          h('label',{className:'memory-field'},'服务地址',h('input',{'aria-label':'重排服务地址',type:'url',value:draft.apiBase,disabled:busy,
            placeholder:'https://api.siliconflow.cn/v1',onChange:event=>change('apiBase',event.target.value)}),
            h('span',{className:'memory-hint'},'填到 /v1 为止；本机 llama-server 可填 http://127.0.0.1:端口/v1')),
          h('label',{className:'memory-field'},'API Key',h('input',{'aria-label':'重排 API Key',type:'password',autoComplete:'new-password',maxLength:8192,
            value:draft.apiKey,disabled:busy,placeholder:(saved.source==='direct'&&saved.hasKey)?'已保存，留空则不变':'',
            onChange:event=>change('apiKey',event.target.value)}))),
        h('label',{className:'memory-field'},'重排模型',h('input',{'aria-label':'重排模型',value:draft.model,maxLength:120,disabled:busy,
          onChange:event=>change('model',event.target.value)}),h('span',{className:'memory-hint'},'也可填 Qwen/Qwen3-Reranker-0.6B 等')),
        h('label',{className:'memory-field'},'候选数',h('input',{'aria-label':'重排候选数',type:'number',min:5,max:50,step:1,
          value:draft.candidates,disabled:busy,onChange:event=>change('candidates',Number(event.target.value))}),h('span',{className:'memory-hint'},'每次查询重新排序前多少条，5–50')),
        draft.enabled&&h('label',{className:'memory-check'},h('input',{type:'checkbox',checked:confirmed,disabled:busy,onChange:event=>setConfirmed(event.target.checked)}),
          h('span',null,'我知道候选记忆片段会发送到所选服务，并按次计费',h('span',{className:'memory-meta',style:{display:'block'}},'每条最多 1000 字。'))),
        h('div',{className:'memory-actions'},h('button',{type:'button',className:'primary',disabled:busy||!canSave,title:disabledReason,onClick:save},busy?'保存中':'保存重排设置')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice)));
    }
    function ModelPicker({info,onSaved}){
      const base=(info.pendingRawModel??info.rawModel)?.fields??{};
      const [draft,setDraft]=React.useState(null),[key,setKey]=React.useState(''),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[preparing,setPreparing]=React.useState(false),[inventory,setInventory]=React.useState(null);
      const [serviceId,setServiceId]=React.useState(''),[serviceForm,setServiceForm]=React.useState(null),[editingService,setEditingService]=React.useState(false),[confirmDelete,setConfirmDelete]=React.useState(false);
      const [section,setSection]=React.useState('vector');
      const inventoryRequest=React.useRef(0);
      const preserveDraft=React.useRef(false);
      const services=Array.isArray(info.embeddingServices)?info.embeddingServices:[];
      const matchService=fields=>services.find(service=>service.apiBase===fields.rawRecallApiBase&&service.apiModel===fields.rawRecallApiModel&&Number(service.dimensions)===Number(fields.rawRecallDimensions));
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
      React.useEffect(()=>{
        if(preserveDraft.current){preserveDraft.current=false;return;}
        const next={rawRecallDevice:'auto',rawRecallIdleMs:0,rawRecallResidentHours:'',...base};
        setDraft(next);setKey('');setServiceId(next.rawRecallModel==='custom-api'?matchService(next)?.id??'':'');
        setServiceForm(null);setEditingService(false);setConfirmDelete(false);
      },[info.revision]);
      React.useEffect(()=>{setInventory(null);loadInventory();},[loadInventory]);
      if(!draft||!info.rawModels)return null;
      const selected=info.rawModels.find(model=>model.id===draft.rawRecallModel),cloud=Boolean(selected?.cloud);
      const selectedService=services.find(service=>service.id===serviceId);
      const selectedInventory=!cloud?inventory?.models?.find(model=>model.id===draft.rawRecallModel):null;
      const installed=selectedInventory?selectedInventory.installed:null,unavailable=installed===false;
      const residency=!draft.rawRecallIdleMs?'always':draft.rawRecallResidentHours?'hours':'idle';
      const choose=model=>{
        // Back to the model already in use: its saved paths return with it; only the residency choice made on this page is kept.
        let next;
        if(model.id===base.rawRecallModel)next={rawRecallDevice:'auto',...base,rawRecallIdleMs:draft.rawRecallIdleMs,rawRecallResidentHours:draft.rawRecallResidentHours};
        else{
          const entry=!model.cloud?inventory?.models?.find(row=>row.id===model.id):null;
          next={...draft,rawRecallModel:model.id,rawRecallDimensions:model.custom?1024:0,rawRecallAllowCloud:false,rawRecallInstallReceipt:model.id===base.rawRecallModel?base.rawRecallInstallReceipt:'',
            rawRecallTimeoutMs:model.engine==='llamacpp'?10000:3000,rawRecallDevice:model.engine==='llamacpp'?'auto':'cpu',...(model.engine==='llamacpp'&&model.id!==draft.rawRecallModel?{rawRecallGgufModel:''}:{}),
            ...(entry?.installed&&model.id!==base.rawRecallModel?entry.settings:{}),
            // A custom service starts blank unless it is the one already saved.
            ...(model.custom?(model.id===base.rawRecallModel?{rawRecallApiBase:base.rawRecallApiBase??'',rawRecallApiModel:base.rawRecallApiModel??'',rawRecallDimensions:base.rawRecallDimensions??1024}:{rawRecallApiBase:'',rawRecallApiModel:'',rawRecallDimensions:1024}):{})};
        }
        setNotice('');setDraft(next);setKey('');setEditingService(false);setConfirmDelete(false);
        setServiceId(model.custom?matchService(next)?.id??'':'');setServiceForm(null);
      };
      const custom=Boolean(selected?.custom),customOk=!custom||Boolean(serviceId||String(draft.rawRecallApiBase??'').trim()&&String(draft.rawRecallApiModel??'').trim());
      const offered=model=>!model.hidden||model.id===draft.rawRecallModel||model.id===info.rawModel?.fields?.rawRecallModel;
      const dirty=JSON.stringify({rawRecallDevice:'auto',rawRecallIdleMs:0,rawRecallResidentHours:'',...base})!==JSON.stringify(draft)||Boolean(key.trim());
      // The choice may have been made before the install check answered; the saved paths always come from it.
      const installedSettings=()=>selectedInventory?.installed&&draft.rawRecallModel!==base.rawRecallModel?{...draft,...selectedInventory.settings}:draft;
      const applyServices=(value,message,nextServiceId=serviceId)=>{
        preserveDraft.current=true;onSaved({...info,...value});
        if(nextServiceId!==undefined)setServiceId(nextServiceId);
        setNotice(message);
      };
      const serviceRequest=async body=>{
        const response=await fetch('/api/basic-memory-settings/embedding-services',{method:'POST',credentials:'same-origin',
          headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({...body,revision:info.revision})});
        const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'向量服务保存失败');return value;
      };
      const chooseService=nextId=>{
        setNotice('');setEditingService(false);setConfirmDelete(false);setServiceForm(null);setKey('');setServiceId(nextId);
        const service=services.find(row=>row.id===nextId);
        if(service)setDraft({...draft,rawRecallApiBase:service.apiBase,rawRecallApiModel:service.apiModel,rawRecallDimensions:service.dimensions});
        else setDraft({...draft,rawRecallApiBase:'',rawRecallApiModel:'',rawRecallDimensions:1024});
      };
      const editService=()=>{
        if(!selectedService)return;
        setServiceForm({name:selectedService.name,apiBase:selectedService.apiBase,apiModel:selectedService.apiModel,
          dimensions:selectedService.dimensions,apiKey:''});
        setEditingService(true);setConfirmDelete(false);setNotice('');
      };
      const saveService=async()=>{
        if(!serviceForm||!selectedService)return;
        setBusy(true);setNotice('');
        try{
          const body={action:'save',id:selectedService.id,name:serviceForm.name,apiBase:serviceForm.apiBase,apiModel:serviceForm.apiModel,
            dimensions:Number(serviceForm.dimensions),...(serviceForm.apiKey.trim()?{apiKey:serviceForm.apiKey.trim()}:{})};
          const value=await serviceRequest(body);
          applyServices(value,'向量服务已保存。',selectedService.id);setEditingService(false);setServiceForm(null);setKey('');
        }catch(error){setNotice(error.message||'向量服务保存失败');}finally{setBusy(false);}
      };
      const saveToList=async()=>{
        setBusy(true);setNotice('');
        try{
          const value=await serviceRequest({action:'save',name:'',apiBase:draft.rawRecallApiBase,apiModel:draft.rawRecallApiModel,
            dimensions:Number(draft.rawRecallDimensions),...(key.trim()?{apiKey:key.trim()}:{})});
          const saved=value.embeddingServices?.find(service=>service.apiModel===draft.rawRecallApiModel&&
            Number(service.dimensions)===Number(draft.rawRecallDimensions));
          applyServices(value,'已存入服务列表；尚未切换模型。',saved?.id??'');setKey('');
        }catch(error){setNotice(error.message||'向量服务保存失败');}finally{setBusy(false);}
      };
      const deleteService=async()=>{
        if(!selectedService)return;
        setBusy(true);setNotice('');
        try{
          const value=await serviceRequest({action:'delete',id:selectedService.id});
          applyServices(value,'向量服务已删除。','');
          setDraft({...draft,rawRecallApiBase:'',rawRecallApiModel:'',rawRecallDimensions:1024});
          setConfirmDelete(false);setEditingService(false);setServiceForm(null);setKey('');
        }catch(error){setNotice(error.message||'向量服务删除失败');}finally{setBusy(false);}
      };
      const changeService=(name,value)=>setServiceForm(current=>({...current,[name]:value}));
      const save=async()=>{setBusy(true);setNotice('');try{
        const currentFields=info.rawModel?.fields??{};
        const customChanged=['rawRecallApiBase','rawRecallApiModel','rawRecallDimensions'].some(name=>draft[name]!==currentFields[name]);
        const modelChanged=draft.rawRecallModel!==currentFields.rawRecallModel||(draft.rawRecallModel==='custom-api'&&customChanged);
        const response=await fetch('/api/basic-memory-settings/model',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({revision:info.revision,settings:installedSettings(),...(serviceId?{serviceId}:{}),...(!serviceId&&key.trim()?{apiKey:key.trim()}:{}),...(modelChanged?{confirmSwitch:true,...(cloud?{cloudConfirmed:Boolean(draft.rawRecallAllowCloud)}:{})}:{})})});
        const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');onSaved(value);setKey('');
        setNotice(modelChanged?'已保存。重启 DSH 后切换到新模型，并自动开始建索引；进度在「状态」页。建好之前，按意思检索暂不可用，文字检索照常。'+(cloud?'建索引会把纳入索引的内容发送到服务商并计费。':''):'已保存，重启 DSH 后生效。');
      }catch(error){setNotice(error.message||'保存失败');}finally{setBusy(false);}};
      const current=info.rawModel?.fields?.rawRecallModel;
      const pendingModel=info.pendingRawModel?.fields?.rawRecallModel;
      const modelBadge=selected?.id===current&&!info.pendingRawModel?badge('ok','使用中'):pendingModel&&pendingModel===draft.rawRecallModel?badge('warn','重启后切换'):null;
      const host=value=>String(value??'').replace(/^[a-z]+:\/\//i,'').split(/[/?#]/)[0];
      const serviceRow=service=>{
        const chosen=service.id===serviceId;
        return h('div',{className:'memory-row',key:service.id},
          h('input',{type:'radio',name:'memory-service',value:service.id,'aria-label':'使用服务：'+service.name,checked:chosen,onChange:()=>chooseService(service.id)}),
          h('div',{className:'memory-row-main'},h('span',null,service.name,service.inUse&&badge('ok','使用中')),
            h('span',{className:'memory-meta'},host(service.apiBase)+' · '+service.apiModel+' · '+service.dimensions+' 维')),
          chosen&&h('div',{className:'memory-actions'},
            h('button',{type:'button',className:'small',disabled:busy,onClick:editService},'编辑'),
            h('button',{type:'button',className:'small danger',disabled:busy||service.inUse,title:service.inUse?'正在使用，不能删除':'',
              onClick:()=>{setConfirmDelete(true);setEditingService(false);setNotice('');}},'删除')));
      };
      const vectorPanel=h('fieldset',{disabled:busy},
        group('模型',{badge:modelBadge,help:'用来按意思查找聊天原话和记忆。模型越大找得越准，占用也越多。切换不会丢失已有记忆，其他模型建好的索引也会保留。'},
          h('label',{className:'memory-field'},'模型',h('select',{'aria-label':'检索模型',value:draft.rawRecallModel,disabled:preparing,onChange:event=>{const model=info.rawModels.find(row=>row.id===event.target.value);if(model)choose(model);}},
            ...[['本地运行',false],['云端 API',true]].map(([label,isCloud])=>h('optgroup',{key:label,label},...info.rawModels.filter(model=>Boolean(model.cloud)===isCloud&&offered(model)).map(model=>{
              const entry=!model.cloud?inventory?.models?.find(row=>row.id===model.id):null;
              return h('option',{key:model.id,value:model.id},modelTitle(model)+(model.id===current?'（当前使用）':entry?(entry.installed?'（已安装）':'（未安装）'):''));
            })))),
            selected&&h('span',{className:'memory-hint'},(TIER_INFO[selected.tier??(selected.cloud?'cloud':'')]??['',''])[1])),
          !cloud&&installed===true&&selected?.id!==current&&h('p',{className:'memory-hint'},'已安装。点「保存」后启用。'),
          !cloud&&h(ModelPreparation,{info,draft,onPrepared:onSaved,onDownloaded:loadInventory,onRunning:setPreparing,installed,downloadBytes:selectedInventory?.downloadBytes||0})),
        cloud&&custom&&group('服务',{help:'可填写任何兼容 OpenAI 向量接口（/embeddings）的服务，地址需为 HTTPS。保存过的服务会留在列表里，密钥只存在本机。'},
          h('div',{role:'radiogroup','aria-label':'已保存的服务'},...services.map(serviceRow),
            h('div',{className:'memory-row'},h('input',{type:'radio',name:'memory-service',value:'','aria-label':'新建服务',checked:!serviceId,onChange:()=>chooseService('')}),
              h('div',{className:'memory-row-main'},h('span',null,'新建服务')))),
          confirmDelete&&selectedService&&h('div',{className:'memory-dialog',role:'dialog','aria-label':'确认删除向量服务'},
            h('p',null,'删除「'+selectedService.name+'」？只删除这条服务配置和它的密钥，不影响已有记忆和索引。'),
            h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>setConfirmDelete(false)},'返回'),
              h('button',{type:'button',className:'danger',disabled:busy,onClick:deleteService},'确认删除'))),
          editingService&&serviceForm&&h('fieldset',{className:'memory-service-form',disabled:busy},
            h('label',{className:'memory-field'},'服务名称',h('input',{value:serviceForm.name,onChange:event=>changeService('name',event.target.value)})),
            selectedService?.inUse?h('p',{className:'memory-hint'},'正在使用的服务只能改名。'):h(React.Fragment,null,
              h('label',{className:'memory-field'},'服务 API 地址',h('input',{type:'url',value:serviceForm.apiBase,onChange:event=>changeService('apiBase',event.target.value)})),
              h('label',{className:'memory-field'},'服务模型名称',h('input',{value:serviceForm.apiModel,maxLength:200,onChange:event=>changeService('apiModel',event.target.value)})),
              h('label',{className:'memory-field'},'服务向量维数',h('input',{type:'number',min:1,max:4096,value:serviceForm.dimensions,onChange:event=>changeService('dimensions',event.target.value)})),
              h('label',{className:'memory-field'},'新 API Key（留空沿用）',h('input',{type:'password',autoComplete:'new-password',value:serviceForm.apiKey,onChange:event=>changeService('apiKey',event.target.value)}))),
            h('div',{className:'memory-actions'},h('button',{type:'button',disabled:busy,onClick:()=>{setEditingService(false);setServiceForm(null);}},'取消编辑'),
              h('button',{type:'button',className:'primary',disabled:busy,onClick:saveService},busy?'保存中':'保存服务'))),
          !serviceId&&h(React.Fragment,null,
            h('label',{className:'memory-field'},'API 地址',h('input',{type:'url',value:draft.rawRecallApiBase??'',placeholder:'https://服务地址/v1',onChange:event=>setDraft({...draft,rawRecallApiBase:event.target.value})}),
              h('span',{className:'memory-hint'},'填到 /v1 为止，例如 https://api.siliconflow.cn/v1')),
            h('label',{className:'memory-field'},'模型名称',h('input',{type:'text',maxLength:200,value:draft.rawRecallApiModel??'',placeholder:'服务商文档里的向量模型名',onChange:event=>setDraft({...draft,rawRecallApiModel:event.target.value})})),
            h('label',{className:'memory-field'},'向量维数',h('input',{type:'number',min:1,max:4096,value:draft.rawRecallDimensions||1024,onChange:event=>setDraft({...draft,rawRecallDimensions:Math.max(1,Math.min(4096,Math.round(Number(event.target.value))||1))})}),
              h('span',{className:'memory-hint'},'模型实际输出的维数，见服务商文档')),
            h('label',{className:'memory-field'},'API Key',h('input',{type:'password',autoComplete:'new-password',maxLength:8192,value:key,placeholder:(info.pendingRawModel??info.rawModel)?.hasSavedApiKey?'已保存，留空沿用':'',onChange:event=>setKey(event.target.value)})))),
        cloud&&!custom&&h('label',{className:'memory-field'},'API Key',h('input',{type:'password',autoComplete:'new-password',maxLength:8192,value:key,placeholder:(info.pendingRawModel??info.rawModel)?.hasSavedApiKey?'已保存，留空沿用':'',onChange:event=>setKey(event.target.value)})),
        !cloud&&h('details',null,h('summary',null,'高级'),
          selected?.engine==='llamacpp'?h('label',{className:'memory-field'},'运行设备',h('select',{'aria-label':'运行设备',value:draft.rawRecallDevice,disabled:preparing,onChange:event=>setDraft({...draft,rawRecallDevice:event.target.value})},
            h('option',{value:'auto'},'自动'),h('option',{value:'cpu'},'CPU'),h('option',{value:'cuda'},'显卡'))):row('运行设备','CPU',{meta:'此模型只用 CPU。'}),
          h('label',{className:'memory-field'},'模型常驻',h('select',{value:residency,disabled:preparing,onChange:event=>{const value=event.target.value;
            setDraft({...draft,rawRecallIdleMs:value==='always'?0:(draft.rawRecallIdleMs||600000),rawRecallResidentHours:value==='hours'?(draft.rawRecallResidentHours||'08:00-01:00'):''});}},
            h('option',{value:'always'},'一直加载'),h('option',{value:'idle'},'空闲一段时间后释放'),h('option',{value:'hours'},'按时段常驻，其余时间空闲释放'))),
          residency!=='always'&&h('label',{className:'memory-field'},'空闲多少分钟后释放',h('input',{type:'number',min:1,max:60,disabled:preparing,value:Math.round((draft.rawRecallIdleMs||600000)/60000),onChange:event=>setDraft({...draft,rawRecallIdleMs:Math.max(1,Math.round(Number(event.target.value)))*60000})})),
          residency==='hours'&&h('label',{className:'memory-field'},'常驻时段（如 08:00-01:00，可跨午夜）',h('input',{type:'text',disabled:preparing,value:draft.rawRecallResidentHours??'',onChange:event=>setDraft({...draft,rawRecallResidentHours:event.target.value})}))),
        cloud&&h('label',{className:'memory-check'},h('input',{type:'checkbox',checked:Boolean(draft.rawRecallAllowCloud),onChange:event=>setDraft({...draft,rawRecallAllowCloud:event.target.checked})}),
          h('span',null,'我知道检索内容会发送到云端，并会产生费用',h('span',{className:'memory-meta',style:{display:'block'}},'保存并重启后会自动建索引，费用按服务商价格计算。'))),
        info.rawRecall?.backend?.cloudPaused&&h('p',{className:'memory-notice',role:'alert'},'云端检索调用失败后已暂停；检查 API Key 后重新保存即可恢复。文字检索不受影响。'),
        h('div',{className:'memory-actions'},custom&&!serviceId&&h('button',{type:'button',disabled:busy||!customOk,title:customOk?'只保存到服务列表，不切换模型':'请先填写地址和模型名称',onClick:saveToList},busy?'处理中':'只存入列表'),
          h('button',{type:'button',className:'primary',disabled:busy||preparing||unavailable||!dirty||(cloud&&!draft.rawRecallAllowCloud)||!customOk,
            title:!dirty?'没有修改':unavailable?'请先下载模型':cloud&&!draft.rawRecallAllowCloud?'请先勾选云端确认':!customOk?'请先填写地址和模型名称':'',onClick:save},busy?'保存中':'保存')),
        notice&&h('p',{className:'memory-notice',role:'status'},notice));
      const sectionTabs=[['vector','向量'],['rerank','重排']];
      return h(React.Fragment,null,
        h('div',{className:'memory-tabs memory-subtabs',role:'tablist','aria-label':'检索模型分类'},
          ...sectionTabs.map(([id,label])=>h('button',{key:id,type:'button',role:'tab',id:'model-section-'+id,
            'aria-controls':'model-section-panel-'+id,'aria-selected':section===id,tabIndex:section===id?0:-1,
            onClick:()=>setSection(id)},label))),
        h('div',{id:'model-section-panel-vector',role:'tabpanel','aria-label':'向量',hidden:section!=='vector'},vectorPanel),
        h('div',{id:'model-section-panel-rerank',role:'tabpanel','aria-label':'重排',hidden:section!=='rerank'},
          h(RerankSettings,{info,onSaved})));
    }
    function Page({readStatus}){
      const [tab,setTab]=React.useState('basic'),[state,setState]=React.useState({status:'loading'});
      const [sessionInfo,setSessionInfo]=React.useState(null),[selected,setSelected]=React.useState([]),[sessionError,setSessionError]=React.useState(''),[saving,setSaving]=React.useState(false);
      const [sessionNotice,setSessionNotice]=React.useState(''),[sessionFilter,setSessionFilter]=React.useState('');
      const sessionRequest=React.useRef(0),savingSessions=React.useRef(false);
      const [newDirectory,setNewDirectory]=React.useState(''),[creatingLibrary,setCreatingLibrary]=React.useState(false),[libraryNotice,setLibraryNotice]=React.useState('');
      const [flagDraft,setFlagDraft]=React.useState(null),[savingFlags,setSavingFlags]=React.useState(false),[flagNotice,setFlagNotice]=React.useState('');
      const [onDemand,setOnDemand]=React.useState(false),[runtimeTick,setRuntimeTick]=React.useState(0);
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
        try{const value=await sessionSettings(change,sessionInfo.revision);if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));setSessionNotice('已保存，从下一新回合生效。');}window.dispatchEvent(new Event(sessionsChanged));}
        catch(error){try{const value=await sessionSettings();if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));}}catch{}if(ticket===sessionRequest.current)setSessionError(error.message||'保存失败');}
        finally{savingSessions.current=false;if(ticket===sessionRequest.current)setSaving(false);}
      };
      const saveSessionDefault=async enabled=>{
        if(savingSessions.current||!hasSessionMemory(sessionInfo))return;
        savingSessions.current=true;const ticket=++sessionRequest.current;setSaving(true);setSessionError('');setSessionNotice('');
        try{
          const response=await fetch('/api/basic-memory-settings/session-default',{method:'POST',credentials:'same-origin',cache:'no-store',
            headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({enabled,revision:sessionInfo.revision})}),
            value=await response.json();
          if(!response.ok||!value.ok)throw Error(value.error||'保存失败');
          if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));setSessionNotice(enabled?'新对话自动开启记忆已开启。':'新对话自动开启记忆已关闭。');}
          window.dispatchEvent(new Event(sessionsChanged));
        }catch(error){
          try{const value=await sessionSettings();if(ticket===sessionRequest.current){setSessionInfo(value);setSelected(enabledSessionIds(value));}}catch{}
          if(ticket===sessionRequest.current)setSessionError(error.message||'保存失败');
        }finally{savingSessions.current=false;if(ticket===sessionRequest.current)setSaving(false);}
      };
      const createLibrary=async()=>{setCreatingLibrary(true);setLibraryNotice('');try{const response=await fetch('/api/basic-memory-settings/libraries',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({action:'create',directory:newDirectory.trim(),revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'创建失败');setLibraryNotice(value.alreadyInitialized?'该目录已有初始化的记忆库；当前使用的库没有改变。':'新记忆库已创建；当前使用的库没有改变。');}catch(error){await refreshStatus();setLibraryNotice(error.message||'创建失败');}finally{setCreatingLibrary(false);}};
      const selectLibrary=async()=>{setCreatingLibrary(true);setLibraryNotice('');try{const response=await fetch('/api/basic-memory-settings/libraries',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({action:'select',directory:newDirectory.trim(),revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'选择失败');setSessionInfo(value);setLibraryNotice(value.pendingDirectory?'已登记目标库，当前库继续使用；下次重新加载时会再次检查待处理内容。':'已取消待切换的记忆库。');}catch(error){await refreshStatus();setLibraryNotice(error.message||'选择失败');}finally{setCreatingLibrary(false);}};
      const saveFlags=async()=>{setSavingFlags(true);setFlagNotice('');try{const response=await fetch('/api/basic-memory-settings/flags',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-basic-memory-settings':'1'},body:JSON.stringify({flags:flagDraft,revision:sessionInfo.revision})}),value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'保存失败');setSessionInfo(value);setFlagNotice(value.pendingFlags?'设置已保存；当前对话继续使用原设置，下次重新加载后生效。':'已恢复当前生效的设置。');}catch(error){await refreshStatus();setFlagNotice(error.message||'保存失败');}finally{setSavingFlags(false);}};
      const tabs=[['basic','记忆'],['model','检索模型'],['status','状态'],['maintenance','维护']];
      const core=state.status==='loading'?'正在检查':state.status==='error'?'无法读取':state.core?'已加载':'未加载';
      const coreBadge=badge(state.status==='loading'?'off':state.core?'ok':'error',core);
      const errorLine=text=>text&&h('p',{className:'memory-notice',role:'alert'},text);
      const noticeLine=text=>text&&h('p',{className:'memory-notice',role:'status'},text);
      let content;
      if(tab==='basic'){
        const current=enabledSessionIds(sessionInfo);
        const sessions=(sessionInfo?.sessions??[]).filter(s=>(s.title+' '+s.id+' '+s.workspace).toLocaleLowerCase().includes(sessionFilter.toLocaleLowerCase()));
        const frameworkBadge=state.status!=='ready'||!state.core||!sessionInfo?coreBadge:sessionInfo.runtime==='loaded'?(sessionInfo.pendingTurns?badge('warn','部分待生效'):badge('ok','已加载')):
          sessionInfo.runtime==='reload-required'?badge('warn','需重新加载'):badge('off','未报告');
        const frameworkHelp=!sessionInfo?'':sessionInfo.runtime==='loaded'?(sessionInfo.pendingTurns?'设置已保存；部分对话从下一新回合开始生效。':'记忆框架已加载，设置已生效。'):
          sessionInfo.runtime==='reload-required'?'更改已保存，重新加载记忆框架（重启 DSH）后生效。':'记忆框架尚未报告设置已加载。';
        // Only states that need attention are shown under a chat; the switch itself says on or off.
        const rowNote=id=>{
          if(!hasSessionMemory(sessionInfo))return '';
          const on=current.includes(id),item=sessionState(sessionInfo,id);
          if(sessionInfo.runtime!=='loaded')return '等待记忆框架加载';
          if(item?.pending)return on?'下一新回合生效':'等待状态同步';
          return on&&item?.active!==true?'下一新回合生效':'';
        };
        content=h(React.Fragment,null,
          group('记忆框架',{badge:frameworkBadge,help:frameworkHelp}),
          sessionInfo&&h('fieldset',{disabled:saving||!hasSessionMemory(sessionInfo)},group('对话',{help:'只有开启记忆的对话会被记住，从下一句开始生效。关闭不会删除已记住的内容，重新开启也不补记关闭期间的内容。'},
            hasAutoEnableNew(sessionInfo)&&h('div',{className:'memory-row'},
              h('div',{className:'memory-row-main'},h('span',null,h('label',{htmlFor:'memory-auto-new'},'新对话自动开启记忆'),help('开启后，新建的对话从第一句起就会被记住；已有对话和手动关闭过的对话不受影响。','新对话自动开启记忆'))),
              h('input',{id:'memory-auto-new','aria-label':'新对话自动开启记忆',type:'checkbox',role:'switch',checked:sessionInfo.sessionMemory.autoEnableNew===true,disabled:saving,onChange:e=>saveSessionDefault(e.target.checked)})),
            !hasSessionMemory(sessionInfo)&&h('p',{className:'memory-notice',role:'status'},'当前运行版本尚未接入对话记忆开关。'),
            h('div',{className:'memory-field'},h('input',{type:'search','aria-label':'查找对话',value:sessionFilter,onChange:e=>setSessionFilter(e.target.value),placeholder:'查找对话：标题、ID 或工作区'})),
            !sessionInfo.sessions?.length?h('p',{className:'memory-hint'},'还没有对话，先打开一个对话。'):!sessions.length?h('p',{className:'memory-hint'},'没有匹配的对话。'):
              h('div',{className:'memory-session-list'},...sessions.map(s=>{
                const on=current.includes(s.id),note=rowNote(s.id);
                return h('div',{className:'memory-row',key:s.id},
                  h('div',{className:'memory-row-main'},h('span',null,s.title),h('span',{className:'memory-meta'},s.unavailable?'当前不可用':s.workspace,note?' · '+note:'')),
                  h('input',{type:'checkbox',role:'switch',checked:on,disabled:saving||(s.unavailable&&!on),'aria-label':(on?'关闭本对话记忆：':'启用本对话记忆：')+s.title,
                    title:on?'已开启，点击关闭':'已关闭，点击开启',onChange:()=>saveSessions({action:on?'unbind':'bind',value:s.id})}));
              })))),
          saving&&noticeLine('保存中…'),noticeLine(sessionNotice),errorLine(sessionError));
      }
      else if(tab==='maintenance')content=group('记忆库',{help:'可以新建或选择另一个独立记忆库。选择后当前库继续运行，下次重新加载时检查两边的待处理内容后再切换。'},
        sessionInfo&&row('当前记忆库',sessionInfo.directory),
        sessionInfo?.pendingDirectory&&row('待切换到',sessionInfo.pendingDirectory),
        sessionInfo?.switchError&&errorLine('上次未切换：'+sessionInfo.switchError),
        sessionInfo&&field('memory-library-path','另一个记忆库',h('input',{id:'memory-library-path',value:newDirectory,onChange:e=>setNewDirectory(e.target.value),placeholder:'目录的完整路径'})),
        sessionInfo&&h('div',{className:'memory-actions'},
          h('button',{type:'button',disabled:creatingLibrary||!newDirectory.trim(),title:newDirectory.trim()?'':'请先填写目录',onClick:createLibrary},creatingLibrary?'正在处理…':'创建新记忆库'),
          h('button',{type:'button',className:'primary',disabled:creatingLibrary||!newDirectory.trim(),title:newDirectory.trim()?'':'请先填写目录',onClick:selectLibrary},'选择此记忆库')),
        noticeLine(libraryNotice),errorLine(sessionError));
      else content=group('运行状态',{extra:h('button',{type:'button',className:'small',onClick:()=>{refreshStatus();setRuntimeTick(value=>value+1);}},'刷新')},
        row('个人记忆服务',coreBadge),
        row('待同步',sessionInfo?.recovery?`${sessionInfo.recovery.sync} 项`:'暂时无法读取',
          {meta:sessionInfo?.recovery?.platformHeld>0?`其中 ${sessionInfo.recovery.platformHeld} 项来自暂停的平台，暂不处理`:undefined}),
        errorLine(sessionError));
      if(tab==='maintenance'&&hasSessionMemory(sessionInfo))content=h(React.Fragment,null,content,h(MemoryDocumentSelection));
      if(tab==='status'){
        const currentModel=sessionInfo?.rawModel?.fields?.rawRecallModel;
        const cloud=Boolean(sessionInfo?.rawModels?.find(model=>model.id===currentModel)?.cloud);
        content=h(React.Fragment,null,content,
          sessionInfo?.pendingRawModel&&h('p',{className:'memory-notice',role:'status'},'待生效：'+rawModelName(sessionInfo,sessionInfo.pendingRawModel.fields)+'，重启 DSH 后切换'+(sessionInfo.pendingRawModelSwitch?'，切换后会自动开始建索引。':'；切换后在这里点「准备索引」。')),
          h(MemoryRuntimeSettings,{info:sessionInfo,modelId:currentModel,cloud,tick:runtimeTick}),
          hasSessionMemory(sessionInfo)&&h(MemoryReviewSettings));
      }
      if(tab==='basic'&&flagDraft&&sessionInfo){
        const flags=[['autoRecall',onDemand?'回答前预先带上相关记忆':'回答前召回事实记忆',onDemand?'每次回答前先查一次记忆，最多附上 4 条相关内容。':'每次回答前召回相关的事实记忆。'],
          ['autoCapture','交流后自动整理','每轮交流后，把值得记住的内容整理成记忆条目。'],
          ['recentContext','短期上下文','切换对话或重连后，带上最近的聊天内容，接得上话。'],
          ['rawRecall','原话检索','按意思查找聊天原话；首次使用需在「检索模型」页准备模型。']];
        const prior=sessionInfo.pendingFlags??sessionInfo.flags,dirty=flags.some(([key])=>flagDraft[key]!==prior[key]);
        content=h(React.Fragment,null,content,h('fieldset',{disabled:savingFlags},group('记忆功能',{
            help:(onDemand?'对话开启记忆后，模型按需查找记忆。':'')+'关闭功能不会删除已有记忆；人格档案按自身设置生效。',
            badge:sessionInfo.pendingFlags?badge('warn','重新加载后生效'):null},
          ...flags.map(([key,label,explain])=>h('div',{className:'memory-row',key},
            h('div',{className:'memory-row-main'},h('span',null,h('label',{htmlFor:'memory-flag-'+key},label),help(explain,label))),
            h('input',{id:'memory-flag-'+key,type:'checkbox',role:'switch',checked:flagDraft[key],onChange:e=>setFlagDraft({...flagDraft,[key]:e.target.checked})}))),
          sessionInfo.settingsError&&errorLine(sessionInfo.settingsError),
          dirty&&h('div',{className:'memory-actions'},
            h('button',{type:'button',onClick:()=>{setFlagDraft(prior);setFlagNotice('');}},'取消'),
            h('button',{type:'button',className:'primary',onClick:saveFlags},savingFlags?'保存中':'保存记忆功能设置')),
          noticeLine(flagNotice))));
      }
      if(tab==='basic'&&sessionInfo)content=h(React.Fragment,null,content,h(TimeZoneSettings,{info:sessionInfo,onSaved:setSessionInfo}));
      if(tab==='basic'&&hasSessionMemory(sessionInfo))content=h(React.Fragment,null,content,h(HandoffSettings,{revision:sessionInfo.revision,onSaved:refreshStatus}));
      if(tab==='model'&&sessionInfo?.rawModel)content=h(ModelPicker,{info:sessionInfo,onSaved:setSessionInfo});
      if(tab==='maintenance'&&sessionInfo?.rawModel)content=h(React.Fragment,null,content,h('details',null,h('summary',null,'检索模型的文件、线程与等待时间（专家）'),h(RawModelSettings,{info:sessionInfo,onSaved:setSessionInfo})));
      if(tab==='basic'&&!sessionInfo&&sessionError)content=h(React.Fragment,null,content,h(BootstrapSetup));
      return h('section',{className:'memory-page'},h('h2',null,'记忆框架'),h('div',{className:'memory-tabs',role:'tablist','aria-label':'记忆设置分类'},...tabs.map(([id,label],i)=>h('button',{key:id,type:'button',role:'tab',id:'memory-tab-'+id,'aria-controls':'memory-tab-panel','aria-selected':tab===id,tabIndex:tab===id?0:-1,onClick:()=>setTab(id),onKeyDown:e=>{if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length][0];setTab(next);document.getElementById('memory-tab-'+next)?.focus();}},label))),h('div',{id:'memory-tab-panel',className:'memory-content',role:'tabpanel','aria-labelledby':'memory-tab-'+tab},content));
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
