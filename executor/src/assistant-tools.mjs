const string={type:'string',minLength:1},integer={type:'integer',minimum:0},object={type:'object'},bool={type:'boolean'},strings={type:'array',items:string};
const specs=[
 ['app_data','appData','读取所有产品、外链库、组合状态、待同步编辑和固定批次',{refresh:bool},[],true],
 ['preview','preview','预览指定产品的原范围，不执行投稿',{profileId:string,urls:strings},['profileId'],true],
 ['profile_update','profile','持久保存指定产品资料，历史投稿保留旧版本',{profileId:string,revision:integer,profile:object},['profileId','revision','profile']],
 ['library_edit','libraryMutation','持久维护外链库或新增/归档/恢复产品',{operation:object},['operation']],
 ['resolve_conflict','resolveConflict','处理已比较的同步冲突，必须携带原云端版本',{id:string,choice:{enum:['cloud','local']},revision:integer},['id','choice','revision']],
 ['media_upload','mediaUpload','将新媒体版本先保存本机，再上传并回读',{profileId:string,kind:{enum:['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4']},dataUrl:string,fileName:string},['profileId','kind','dataUrl']],
 ['task_detail','taskDetails','读取原任务详情和提交边界',{taskId:string},['taskId'],true],
 ['prepare_task','prepareTask','准备原固定任务，不点击最终提交、不重置预算',{taskId:string,acceptanceId:string},['taskId','acceptanceId']],
 ['run_task','runTask','仅在用户明确允许投稿后运行原固定任务；结果未知必须先核验',{taskId:string,acceptanceId:string},['taskId','acceptanceId']],
 ['verify_task','verify','核验原任务，保留未知边界，不创建重复投稿',{taskId:string},['taskId']],
 ['pause','pause','暂停执行，保留原范围、原任务和预算',{},[]],
 ['sync','sync','同步与核验本机待同步内容，不恢复投稿',{},[]],
 ['gmail_status','gmailStatus','读取本机只读邮箱连接状态，不返回凭据',{},[],true],
 ['gmail_sync','gmailSync','只读同步已授权邮箱，不发送或修改邮件',{},[]],
];
export const assistantTools=specs.map(([name,,description,properties,required,readOnly])=>({name:'externallink_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:!!readOnly,destructiveHint:false,openWorldHint:true}}));
function redact(value){if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|secret|token|authorization|api.?key|密码/i.test(key)).map(([key,v])=>[key,redact(v)]));return value;}
export async function callAssistantTool(name,args,request){
 const index=assistantTools.findIndex(tool=>tool.name===name);if(index<0)throw Error('未知助手工具');
 const schema=assistantTools[index].inputSchema;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(schema.properties,key)))throw Error('无效工具参数');
 for(const key of schema.required)if(!Object.hasOwn(args,key))throw Error('缺少参数 '+key);
 for(const [key,value]of Object.entries(args)){const rule=schema.properties[key];if(rule.enum&&!rule.enum.includes(value)||rule.type==='string'&&(typeof value!=='string'||!value.trim())||rule.type==='integer'&&(!Number.isInteger(value)||value<0)||rule.type==='boolean'&&typeof value!=='boolean'||rule.type==='object'&&(!value||typeof value!=='object'||Array.isArray(value))||rule.type==='array'&&(!Array.isArray(value)||value.some(v=>typeof v!=='string')))throw Error('无效参数 '+key);}
 return redact(await request(specs[index][1],args));
}
