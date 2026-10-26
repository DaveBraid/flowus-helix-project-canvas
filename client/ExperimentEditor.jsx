import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, LoaderCircle, ExternalLink } from 'lucide-react';

/** 展示实验写回弹层；输入当前图及操作回调，输出保留失败输入的表单。 */
export default function ExperimentEditor({ editor, nodes, edges, statusOptions, onClose, onCommit, onPrepareLeave, statusAppearance }) {
  const dialogRef = useRef(null);
  const node = nodes.find(item => item.id === editor.nodeId);
  const [title, setTitle] = useState('');
  const [targetId, setTargetId] = useState(editor.targetId || '');
  const [sourceIds, setSourceIds] = useState(() => editor.type === 'create' ? (editor.sourceId ? [editor.sourceId] : []) : sourcesFor(editor.targetId));
  const [working, setWorking] = useState(false);
  const [retryLocked, setRetryLocked] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID()); // 重试沿用同一标识，避免超时后重复创建。
  const target = nodes.find(item => item.id === targetId);
  const knownIds = new Set(nodes.map(item => item.id));
  const outsideSources = sourceIds.filter(id => !knownIds.has(id));
  const downstream = edges.filter(edge => edge.source === node?.id).map(edge => nodes.find(item => item.id === edge.target)).filter(Boolean);
  const heading = { create: '新增实验', connect: '连接已有实验', status: '选择实验状态', delete: '删除实验前确认' }[editor.type];

  /** 取得目标完整来源并加入当前起点；输入目标 ID，输出保留原关系的来源数组。 */
  function sourcesFor(id) {
    const selected = nodes.find(item => item.id === id);
    return [...new Set([...(selected?.data?.sourceIds || edges.filter(edge => edge.target === id).map(edge => edge.source)), ...(editor.sourceId && editor.sourceId !== id ? [editor.sourceId] : [])])];
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    if (editor.anchor) {
      const rect = dialog.getBoundingClientRect(), anchor = editor.anchor;
      dialog.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, innerWidth - rect.width - 8))}px`;
      dialog.style.top = `${anchor.bottom + rect.height + 14 < innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - rect.height - 6)}px`;
    }
    return () => dialog.close();
  }, [editor.anchor]);

  /** 提交已确认字段；输入补丁，输出结果或保留在原弹层的错误信息。 */
  async function commit(payload) {
    if (working) return;
    setWorking(true); setError('');
    try { await onCommit(editor.type, { ...payload, nodeId: editor.type === 'connect' ? targetId : editor.nodeId, requestId: requestId.current }); }
    catch (failure) { if (failure.retrySameRequest) setRetryLocked(true); setError(failure.message || '保存失败，请重试。输入已保留。'); }
    finally { setWorking(false); }
  }

  /** 提交新增或多来源关系；输入表单事件，输出经过基础校验的写回请求。 */
  function submit(event) {
    event.preventDefault();
    if (editor.type === 'create') return commit({ title: title.trim(), sourceIds });
    if (!targetId) { setError('请先选择目标实验。'); return; }
    commit({ sourceIds });
  }

  return createPortal(<dialog ref={dialogRef} className={`experiment-editor ${editor.type === 'status' ? 'status-editor' : ''}`} aria-label={heading} onCancel={event => { event.preventDefault(); if (!working && !retryLocked) onClose(); }} onClick={event => { if (event.target === dialogRef.current && !working && !retryLocked) onClose(); }}>
    <section onClick={event => event.stopPropagation()}>
      <header><h2>{heading}</h2><button className="tool" type="button" title="关闭" aria-label="关闭编辑窗口" disabled={working} onClick={onClose}><X size={17}/></button></header>
      {editor.type === 'status' ? <div className="status-options" role="menu" aria-label="实验状态" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        {statusOptions.length ? statusOptions.map(status => { const { Icon, tone } = statusAppearance(status); return <button key={status} type="button" className={`status-option is-${tone}`} role="menuitemradio" aria-checked={node?.data.status === status} disabled={working} onClick={() => node?.data.status === status ? onClose() : commit({ status })}><Icon size={14}/><span>{status}</span>{node?.data.status === status && <Check size={14}/>}</button>; }) : <p className="editor-note">实验表未提供可用状态，请刷新后重试。</p>}
      </div> : editor.type === 'delete' ? <div className="delete-impact">
        <p>将前往 FlowUs 删除「{node?.data.title}」。此处不会删除记录。</p>
        <p>当前画布中有 {edges.filter(edge => edge.target === node?.id).length} 条来源关系、{downstream.length} 个后续实验受影响。</p>
        {!!downstream.length && <ul>{downstream.map(item => <li key={item.id}>{item.data.title}</li>)}</ul>}
        <p className="editor-note">删除后回到画布，点击刷新重新读取关系和连续编号。其他项目的引用不在此列表中。</p>
        <a className="editor-primary" href={node?.data.url} target="_top" onClick={event => onPrepareLeave(event)}>确认影响并前往 FlowUs <ExternalLink size={14}/></a>
      </div> : <form onSubmit={submit}>
        {editor.type === 'create' ? <><label className="editor-field">实验名称<input autoFocus required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="输入实验名称" disabled={working || retryLocked}/></label><p className="editor-note">编号按实验关系自动生成。</p></> : <label className="editor-field">目标实验<select autoFocus required value={targetId} disabled={working} onChange={event => { setTargetId(event.target.value); setSourceIds(sourcesFor(event.target.value)); setError(''); }}><option value="">选择已有实验</option>{nodes.filter(item => item.id !== editor.sourceId).map(item => <option value={item.id} key={item.id}>{item.data.title}</option>)}</select></label>}
        <fieldset disabled={working || retryLocked || !!outsideSources.length}><legend>来源实验（可多选）</legend><div className="source-options">{nodes.filter(item => item.id !== targetId).map(item => <label key={item.id}><input type="checkbox" checked={sourceIds.includes(item.id)} onChange={event => setSourceIds(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))}/><span>{item.data.title}</span></label>)}{!nodes.length && <p className="editor-note">当前没有实验，可直接新建起始实验。</p>}</div></fieldset>
        {!!outsideSources.length && <p className="form-error">目标含 {outsideSources.length} 个当前画布外来源。为避免清除关系，请在 FlowUs 中修改。</p>}
        {editor.type === 'create' && <p className="editor-note">新实验将分别引用所选来源的正文。之后修改连接不会重新继承正文。</p>}
        {editor.type === 'connect' && target && <p className="editor-note">仅更新「{target.data.title}」的来源关系，保留其正文和状态。</p>}
        <button className="editor-primary" disabled={working || !!outsideSources.length || (editor.type === 'connect' && !targetId)}>{working ? <LoaderCircle className="spin" size={16}/> : editor.type === 'create' ? '新增实验' : '保存连接'}</button>
      </form>}
      {working && editor.type === 'status' && <p role="status" className="editor-note">正在更新状态…</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
  </dialog>, document.body);
}
