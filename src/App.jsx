import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const api = async (url, opts = {}, actor = 'editor-a') => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Actor': actor, ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.code = r.status; throw e; }
  return data;
};

const STATUS_LABEL = { rescue: '救助中', foster: '寄养中', adoptable: '可领养', adopted: '已领养', withdrawn: '已下架' };
const TASK_LABEL = { queued: '排队中', running: '执行中', done: '完成', done_with_exclusions: '完成(有排除)', cancelled: '已取消', failed: '失败' };
const FRAG_LABEL = { pending_approval: '待批准', needs_review: '需人工复核', approved: '已批准', withdrawn: '已撤回' };

function App() {
  const [tab, setTab] = useState('animals');
  const [animals, setAnimals] = useState([]);
  const [sel, setSel] = useState(null);        // 当前动物详情
  const [detail, setDetail] = useState(null);
  const [pub, setPub] = useState([]);          // 公开片段
  const [tasks, setTasks] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [msg, setMsg] = useState('');
  const [actorName, setActorName] = useState('editor-a');

  const say = (m) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };
  const reload = useCallback(async () => {
    setAnimals(await api('/api/animals'));
    setTasks(await api('/api/tasks'));
    setReviews(await api('/api/review-queue'));
    if (sel) {
      setDetail(await api(`/api/animals/${sel}`));
      setPub(await api(`/api/animals/${sel}/public`));
    }
  }, [sel]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);

  const doAct = async (fn, ok) => { try { const r = await fn(); say(ok || '操作成功'); await reload(); return r; } catch (e) { say(`错误(${e.code}): ${e.message}`); } };

  // ---------- 各面板 ----------
  const AnimalPanel = () => {
    const [form, setForm] = useState({ alias: '', species: '猫', breed: '', real_name: '', rescuer_phone: '', rescue_address: '', internal_notes: '' });
    const a = detail?.animal;
    return <div>
      <h3>新建动物档案（内部记录）</h3>
      <div style={grid}>
        {[['alias','化名(公开)'],['species','物种'],['breed','品种'],['real_name','真实呼名(内部)'],
          ['rescuer_phone','救助人电话(敏感)'],['rescue_address','救助详细地址(敏感)']].map(([k,label]) =>
          <label key={k}>{label}<input value={form[k]} onChange={e=>setForm({...form,[k]:e.target.value})}/></label>)}
        <label style={{gridColumn:'1/-1'}}>内部备注<textarea value={form.internal_notes} onChange={e=>setForm({...form,internal_notes:e.target.value})}/></label>
      </div>
      <button onClick={()=>doAct(()=>api('/api/animals',{method:'POST',body:JSON.stringify(form)},actorName),'档案已创建')}>创建</button>

      <h3>档案列表</h3>
      <table><thead><tr><th>ID</th><th>化名</th><th>物种</th><th>状态</th><th>版本</th><th>最后修改</th><th/></tr></thead>
      <tbody>{animals.map(x=><tr key={x.id}>
        <td>{x.id}</td><td>{x.alias}</td><td>{x.species}</td><td>{STATUS_LABEL[x.status]||x.status}</td>
        <td>v{x.version}</td><td>{x.updated_by}</td>
        <td><button onClick={()=>setSel(x.id)}>编辑</button></td></tr>)}</tbody></table>

      {a && <div style={card}>
        <h3>编辑 #{a.id} {a.alias}（当前 v{a.version}，并发冲突将返回409）</h3>
        <p>内部字段：真实呼名={a.real_name||'-'}｜救助人电话={a.rescuer_phone||'-'}｜地址={a.rescue_address||'-'}</p>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {Object.entries(STATUS_LABEL).map(([k,label])=>
            <button key={k} disabled={a.status===k}
              onClick={()=>doAct(()=>api(`/api/animals/${a.id}/status`,{method:'PUT',body:JSON.stringify({status:k,baseVersion:a.version})},actorName),
                k==='adopted'?'已标记领养完成：关联招领片已撤回、排队任务已取消':'状态已更新')}>
              →{label}</button>)}
        </div>
        <h4>状态历史</h4>
        <ul>{detail.status_history.map(h=><li key={h.id}>{h.at} {h.actor}: {h.from_status||'∅'} → {h.to_status}</li>)}</ul>
        <h4>私密备注（永不进入公开稿/导出包）</h4>
        <ul>{detail.private_notes.map(n=><li key={n.id}>[{n.at}] {n.author}: {n.body}</li>)}</ul>
        <PrivateNoteForm animalId={a.id} actor={actorName} onDone={()=>doAct(async()=>{},'备注已保存')}/>
      </div>}
    </div>;
  };

  const PrivateNoteForm = ({animalId, actor, onDone}) => {
    const [body,setBody]=useState('');
    return <div><input placeholder='新私密备注…' value={body} onChange={e=>setBody(e.target.value)}/>
      <button onClick={async()=>{await api(`/api/animals/${animalId}/private-notes`,{method:'POST',body:JSON.stringify({body})},actor);setBody('');onDone();}}>保存备注</button></div>;
  };

  const TimelinePanel = () => {
    const [f,setF]=useState({event_date:'2026-10-01',title:'',body_internal:'',subtitle_text:'',narration_script:''});
    if(!sel) return <p>请先在“档案”页选择动物</p>;
    return <div>
      <h3>新增时间线事件（正文/字幕/旁白均会过脱敏检测）</h3>
      <div style={grid}>
        <label>日期<input type='date' value={f.event_date} onChange={e=>setF({...f,event_date:e.target.value})}/></label>
        <label>标题<input value={f.title} onChange={e=>setF({...f,title:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>正文(内部)<textarea value={f.body_internal} onChange={e=>setF({...f,body_internal:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>字幕稿<textarea value={f.subtitle_text} onChange={e=>setF({...f,subtitle_text:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>旁白脚本<textarea value={f.narration_script} onChange={e=>setF({...f,narration_script:e.target.value})}/></label>
      </div>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/timeline`,{method:'POST',body:JSON.stringify(f)},actorName),'事件已添加')}>添加事件</button>
      <h4>已有事件</h4>
      <ul>{detail?.timeline.map(e=><li key={e.id}><b>{e.event_date} {e.title}</b><br/>正文:{e.body_internal}<br/>字幕:{e.subtitle_text||'-'}<br/>旁白:{e.narration_script||'-'}</li>)}</ul>
    </div>;
  };

  const CharacterPanel = () => {
    const [f,setF]=useState({real_name:'',public_alias:'',role:'救助人',bio_internal:'',contact_phone:'',consent_form:''});
    if(!sel) return <p>请先在“档案”页选择动物</p>;
    return <div>
      <h3>叙事角色（真实姓名/电话仅内部，公开只用化名）</h3>
      <div style={grid}>
        <label>真实姓名(内部)<input value={f.real_name} onChange={e=>setF({...f,real_name:e.target.value})}/></label>
        <label>公开化名<input value={f.public_alias} onChange={e=>setF({...f,public_alias:e.target.value})}/></label>
        <label>角色<select value={f.role} onChange={e=>setF({...f,role:e.target.value})}>
          {['救助人','领养人','兽医','志愿者','寄养家庭'].map(r=><option key={r}>{r}</option>)}</select></label>
        <label>联系电话(敏感)<input value={f.contact_phone} onChange={e=>setF({...f,contact_phone:e.target.value})}/></label>
        <label>授权书编号<input value={f.consent_form} onChange={e=>setF({...f,consent_form:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>简介(内部)<textarea value={f.bio_internal} onChange={e=>setF({...f,bio_internal:e.target.value})}/></label>
      </div>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/characters`,{method:'POST',body:JSON.stringify(f)},actorName),'角色已添加')}>添加角色</button>
      <ul>{detail?.characters.map(c=><li key={c.id}>{c.public_alias||'(未设化名)'} — {c.role}（内部:{c.real_name} {c.contact_phone}）</li>)}</ul>
    </div>;
  };

  const MediaPanel = () => {
    const [f,setF]=useState({kind:'photo',filename:'',caption_internal:'',exifText:'{"GPSLatitude":31.23,"GPSLongitude":121.47,"Make":"Sony","OwnerName":"张三"}'});
    if(!sel) return <p>请先在“档案”页选择动物</p>;
    return <div>
      <h3>媒体素材（人脸/声音/背景自动进入人工复核队列）</h3>
      <div style={grid}>
        <label>类型<select value={f.kind} onChange={e=>setF({...f,kind:e.target.value})}>
          <option value='photo'>照片</option><option value='video'>视频</option><option value='audio'>音频</option></select></label>
        <label>文件名<input value={f.filename} onChange={e=>setF({...f,filename:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>说明文字<textarea value={f.caption_internal} onChange={e=>setF({...f,caption_internal:e.target.value})}/></label>
        <label style={{gridColumn:'1/-1'}}>EXIF(JSON)<textarea value={f.exifText} onChange={e=>setF({...f,exifText:e.target.value})}/></label>
      </div>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/media`,{method:'POST',body:JSON.stringify({kind:f.kind,filename:f.filename,caption_internal:f.caption_internal,exif:JSON.parse(f.exifText||'{}')})},actorName),'媒体已登记，复核项已入队')}>登记媒体</button>
      <table><thead><tr><th>ID</th><th>类型</th><th>文件</th><th>许可状态</th><th>复核</th><th/></tr></thead>
      <tbody>{detail?.media.map(m=><tr key={m.id}>
        <td>{m.id}</td><td>{m.kind}</td><td>{m.filename}</td>
        <td style={{color:m.license_status==='revoked'?'red':'green'}}>{m.license_status}</td><td>{m.review_status}</td>
        <td>{m.license_status==='granted'&&<button onClick={()=>doAct(()=>api(`/api/media/${m.id}/revoke`,{method:'POST'},actorName),'许可已撤销：引用它的排队任务已取消')}>撤销许可</button>}</td>
      </tr>)}</tbody></table>
    </div>;
  };

  const PublishPanel = () => {
    const [idem,setIdem]=useState('');
    if(!sel) return <p>请先在“档案”页选择动物</p>;
    return <div>
      <h3>公开片段：来源与批准依据</h3>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/fragments/build`,{method:'POST'},actorName),'已按白名单+检测重新生成公开片段')}>从内部记录生成公开片段</button>
      <table><thead><tr><th>ID</th><th>字段</th><th>用途</th><th>内容(脱敏后)</th><th>状态</th><th>来源</th><th>批准依据</th><th/></tr></thead>
      <tbody>{pub.map(f=><tr key={f.id} style={{opacity:f.status==='withdrawn'?0.5:1}}>
        <td>{f.id}</td><td>{f.field}</td><td>{f.purpose==='adoption_flyer'?'招领片':'故事'}</td>
        <td style={{maxWidth:260}}>{f.content}{f.findings.length>0&&<div style={{color:'#b45309',fontSize:12}}>命中:{f.findings.map(x=>x.label+'@'+x.surface).join(',')}</div>}</td>
        <td>{FRAG_LABEL[f.status]}{f.withdraw_reason&&<div style={{fontSize:12,color:'red'}}>{f.withdraw_reason}</div>}</td>
        <td>{f.source.type}#{f.source.id}.{f.source.field}</td>
        <td>{f.approval?`${f.approval.approver}｜${f.approval.basis}`:'—'}</td>
        <td>{['pending_approval','needs_review'].includes(f.status)&&
          <button onClick={()=>doAct(()=>api(`/api/fragments/${f.id}/approve`,{method:'POST',body:JSON.stringify({basis:f.status==='needs_review'?'manual_review:人工复核通过':'whitelist_pass+scan_clean'})},actorName),'已批准')}>批准</button>}</td>
      </tr>)}</tbody></table>

      <h3>提交异步任务（幂等键防重复投稿）</h3>
      <input placeholder='幂等键，如 post-2026-10-03-01' value={idem} onChange={e=>setIdem(e.target.value)}/>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/tasks`,{method:'POST',headers:{'Idempotency-Key':idem},body:JSON.stringify({type:'publish_preview'})},actorName).then(r=>say(r.deduplicated?'重复投稿被去重，返回已有任务':'预览任务已排队')),'')}>生成脱敏预览</button>
      <button onClick={()=>doAct(()=>api(`/api/animals/${sel}/tasks`,{method:'POST',headers:{'Idempotency-Key':idem},body:JSON.stringify({type:'export_package'})},actorName).then(r=>say(r.deduplicated?'重复投稿被去重，返回已有任务':'导出任务已排队')),'')}>导出公开包</button>
      <button onClick={()=>doAct(()=>api('/api/tasks/drain',{method:'POST'},actorName),'队列已处理')}>立即处理队列</button>
    </div>;
  };

  const TasksPanel = () => <div>
    <h3>任务队列</h3>
    <table><thead><tr><th>ID</th><th>类型</th><th>动物</th><th>状态</th><th>幂等键</th><th>取消/排除原因</th><th>产物</th><th>授权</th></tr></thead>
    <tbody>{tasks.map(t=><tr key={t.id}>
      <td>{t.id}</td><td>{t.type}</td><td>#{t.animal_id}</td><td>{TASK_LABEL[t.status]}</td>
      <td style={{fontSize:12}}>{t.idempotency_key}</td>
      <td style={{fontSize:12,color:'#b45309'}}>{t.cancel_reason||(t.exclusions_json&&t.exclusions_json!=='[]'?t.exclusions_json:'')}</td>
      <td style={{fontSize:12}}>{t.result_path}</td>
      <td>{t.status.startsWith('done')&&t.type==='export_package'&&<GrantButton taskId={t.id}/>}</td>
    </tr>)}</tbody></table>
  </div>;

  const GrantButton = ({taskId}) => {
    const [token,setToken]=useState('');
    return <span>
      <button onClick={async()=>{const r=await api(`/api/tasks/${taskId}/grants`,{method:'POST',body:JSON.stringify({issued_to:'partner-org'})});setToken(r.token);}}>签发下载授权</button>
      {token&&<div style={{fontSize:12}}>
        <code>{token.slice(0,12)}…</code>
        <button onClick={()=>doAct(()=>api('/api/grants/revoke',{method:'POST',body:JSON.stringify({token,reason:'手动撤销'})},actorName),'授权已撤销（外部已下载副本无法追回）')}>撤销</button>
      </div>}
    </span>;
  };

  const ReviewPanel = () => <div>
    <h3>人工复核队列（机器无法可靠判断的项）</h3>
    <p style={{color:'#666'}}>人脸、可辨识人声、照片/视频背景（门牌、车牌、地标等）必须由人确认。</p>
    <table><thead><tr><th>ID</th><th>动物</th><th>媒体</th><th>类目</th><th>说明</th><th>状态</th><th/></tr></thead>
    <tbody>{reviews.map(r=><tr key={r.id}>
      <td>{r.id}</td><td>#{r.animal_id}</td><td>#{r.media_id}</td><td>{r.category_label||r.category}</td>
      <td>{r.detail}</td><td>{r.status}</td>
      <td>{r.status==='open'&&<button onClick={()=>doAct(()=>api(`/api/review-queue/${r.id}/resolve`,{method:'POST',body:JSON.stringify({resolution:'人工确认无隐私风险'})},actorName),'已结案')}>结案</button>}</td>
    </tr>)}</tbody></table>
  </div>;

  const TABS = [['animals','档案'],['timeline','时间线'],['characters','角色'],['media','媒体'],['publish','公开稿'],['tasks','任务/导出'],['review','人工复核']];
  return <div style={{fontFamily:'system-ui',maxWidth:1200,margin:'0 auto',padding:16}}>
    <h1>🐾 宠物救助故事创作台</h1>
    <div style={{marginBottom:8}}>当前操作人：
      <select value={actorName} onChange={e=>setActorName(e.target.value)}>
        <option>editor-a</option><option>editor-b</option><option>reviewer-1</option></select>
      {sel&&<span style={{marginLeft:16}}>当前动物：#{sel}</span>}
    </div>
    {msg&&<div style={{padding:8,background:msg.startsWith('错误')?'#fee2e2':'#dcfce7',borderRadius:6,marginBottom:8}}>{msg}</div>}
    <nav style={{display:'flex',gap:4,marginBottom:12}}>
      {TABS.map(([k,label])=><button key={k} onClick={()=>setTab(k)}
        style={{fontWeight:tab===k?'bold':'normal',background:tab===k?'#dbeafe':'#f3f4f6'}}>{label}</button>)}
    </nav>
    {tab==='animals'&&<AnimalPanel/>}
    {tab==='timeline'&&<TimelinePanel/>}
    {tab==='characters'&&<CharacterPanel/>}
    {tab==='media'&&<MediaPanel/>}
    {tab==='publish'&&<PublishPanel/>}
    {tab==='tasks'&&<TasksPanel/>}
    {tab==='review'&&<ReviewPanel/>}
  </div>;
}

const grid = { display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 };
const card = { border:'1px solid #ddd', borderRadius:8, padding:12, marginTop:12 };

createRoot(document.getElementById('root')).render(<App/>);
