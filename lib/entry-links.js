export const ENTRY_END='<!-- dsh-memory-entry:end -->';
export const TOPIC_LINE_PREFIX='主题：';
export const TOPIC_TAG='dsh-topic';

export function topicFileName(tag){
  return String(tag??'')
    .replace(/[\/\\:*?"<>|]/g,'_')
    .replace(/^[\s.]+|[\s.]+$/g,'');
}

export function topicFileNames(tags=[]){
  const seen=new Set(),result=[];
  for(const tag of tags){
    const name=topicFileName(tag);
    if(name&&!seen.has(name)){seen.add(name);result.push(name);}
  }
  return result;
}

export function topicLinkLine(tags=[]){
  const names=topicFileNames(tags);
  return names.length?TOPIC_LINE_PREFIX+names.map(name=>'[['+name+']]').join(' '):'';
}

export function withEntryTopics(content,tags=[]){
  const text=String(content??'');
  const end=text.indexOf(ENTRY_END);
  if(end<0||text.indexOf(ENTRY_END,end+ENTRY_END.length)>=0)throw Error('Managed entry end marker is missing or ambiguous');
  const prefix=text.slice(0,end+ENTRY_END.length),suffix=text.slice(end+ENTRY_END.length);
  const newline=suffix.includes('\r\n')?'\r\n':'\n';
  const lines=suffix.split(/\r?\n/);
  if(lines[0]==='')lines.shift();
  const kept=lines.filter(line=>!line.startsWith(TOPIC_LINE_PREFIX));
  const line=topicLinkLine(tags);
  return prefix+newline+[...line?[line]:[],...kept].join(newline);
}

export function topicsDirectory(entriesDirectory){
  return String(entriesDirectory??'').replace(/\/entries$/,'/topics');
}

export function isTopicPath(value,entriesDirectory){
  return String(value??'').replace(/\\/g,'/').startsWith(topicsDirectory(entriesDirectory)+'/');
}

export function topicPageContent(name){
  return '# '+name+'\n\n本页由记忆框架自动维护，可在下方自由补充\n';
}

export function topicPageMetadata(name){
  return {title:name,type:'note',tags:[TOPIC_TAG],embed:false};
}
