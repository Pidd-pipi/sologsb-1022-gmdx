import { initialDocument, tokenizeText } from '../lib/data';
import { buildMergePlan, finalizeMerge, relocateTokenAnchor, MergeValidationError } from '../lib/merge';
import type { Annotation, Sentence, TextDocument, VersionSnapshot, WorkspaceState, MergeResolution } from '../lib/types';
import { clone } from '../lib/editor';

function base(): { doc: TextDocument; snapshot: VersionSnapshot } {
  const doc = clone(initialDocument);
  const snapshot = clone(doc.snapshots[0]);
  return { doc, snapshot };
}

function withEdits(doc: TextDocument, mutate: (doc: TextDocument) => void): TextDocument {
  const next = clone(doc);
  mutate(next);
  next.updatedAt = new Date().toISOString();
  return next;
}

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name} ${detail}`);
  }
}

// 1. 唯一匹配的注释沿用：甲改了词级注释正文，乙没动 → 采用甲稿，锚点仍是原 token
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    const a = d.annotations.find((x) => x.id === 'annotation-3')!;
    a.body = '甲稿新校：鹏字异文更新。';
  });
  const incoming = clone(base().doc);
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  check('唯一匹配无冲突', plan.conflicts.length === 0, `conflicts=${plan.conflicts.length}`);
  const out = finalizeMerge(plan, {}, { local, incoming });
  const a3 = out.annotations.find((x) => x.id === 'annotation-3')!;
  check('沿用甲稿修改', a3.body === '甲稿新校：鹏字异文更新。');
  check('词级锚点保留', a3.anchorType === 'word');
}

// 2. 原词消失：乙稿删去了“鹏”字，词级注释应迁到句子
{
  const { doc, snapshot } = base();
  const local = clone(doc);
  const incoming = withEdits(doc, (d) => {
    const s = d.chapters[0].sentences.find((x) => x.id === 'sentence-1-3')!;
    s.text = '化而为鸟，其名为大鸟。';
    s.tokens = tokenizeText(s.text, s.id);
  });
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const res: Record<string, MergeResolution> = {};
  for (const c of plan.conflicts) res[c.id] = 'incoming';
  const out = finalizeMerge(plan, res, { local, incoming });
  const a3 = out.annotations.find((x) => x.id === 'annotation-3')!;
  check('原词消失迁移到句', a3.anchorType === 'sentence' && a3.anchorId === 'sentence-1-3',
    `type=${a3.anchorType} anchor=${a3.anchorId}`);
  check('迁移标题带标记', a3.title.includes('迁移'));
}

// 3. 同一条注释两边都改 → 并列冲突；选 both → 两条都在
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    d.annotations.find((x) => x.id === 'annotation-3')!.body = '甲：改为凤';
  });
  const incoming = withEdits(doc, (d) => {
    d.annotations.find((x) => x.id === 'annotation-3')!.body = '乙：改为朋';
  });
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const conflict = plan.conflicts.find((c) => c.type === 'annotation');
  check('两边都改登记冲突', !!conflict && conflict.localAnnotation?.body === '甲：改为凤' && conflict.incomingAnnotation?.body === '乙：改为朋');
  let out = finalizeMerge(plan, { [conflict!.id]: 'both' }, { local, incoming });
  const a3s = out.annotations.filter((x) => x.title.startsWith('鹏字异文'));
  check('并列保留两条', a3s.length === 2, `count=${a3s.length}`);
  // 未决时拒绝写入
  let threw = false;
  try { finalizeMerge(plan, {}, { local, incoming }); } catch { threw = true; }
  check('未决冲突拒绝写入', threw);
}

// 4. 互见关系不同 → 冲突并列
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    const a = d.annotations.find((x) => x.id === 'annotation-1')!;
    a.body = '甲改';
    a.references = ['annotation-3'];
  });
  const incoming = withEdits(doc, (d) => {
    const a = d.annotations.find((x) => x.id === 'annotation-1')!;
    a.body = '乙改';
    a.references = ['annotation-2', 'annotation-4'];
  });
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const conflict = plan.conflicts.find((c) => c.reason.includes('互见'));
  check('互见不同登记冲突', !!conflict);
}

// 5. 句子正文两边都改 → sentence-text 冲突，选甲则正文为甲
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    const s = d.chapters[0].sentences[1];
    s.text = '鲲之大，莫知其几千里也。';
    s.tokens = tokenizeText(s.text, s.id);
  });
  const incoming = withEdits(doc, (d) => {
    const s = d.chapters[0].sentences[1];
    s.text = '鲲之大，不知几千里也。';
    s.tokens = tokenizeText(s.text, s.id);
  });
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const conflict = plan.conflicts.find((c) => c.type === 'sentence-text');
  check('句子冲突', !!conflict);
  const out = finalizeMerge(plan, { [conflict!.id]: 'local' }, { local, incoming });
  const s = out.chapters[0].sentences[1];
  check('选甲正文', s.text === '鲲之大，莫知其几千里也。', s.text);
}

// 6. 一方删除一方修改 → delete-vs-edit 冲突
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    d.annotations = d.annotations.filter((x) => x.id !== 'annotation-3');
  });
  const incoming = withEdits(doc, (d) => {
    d.annotations.find((x) => x.id === 'annotation-3')!.body = '乙改了';
  });
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const conflict = plan.conflicts.find((c) => c.type === 'delete-vs-edit');
  check('删改冲突', !!conflict);
  const outKeep = finalizeMerge(plan, { [conflict!.id]: 'keep' }, { local, incoming });
  check('保留修改方', outKeep.annotations.some((x) => x.id === 'annotation-3' && x.body === '乙改了'));
  const outDel = finalizeMerge(plan, { [conflict!.id]: 'delete' }, { local, incoming });
  check('随对方删除', !outDel.annotations.some((x) => x.id === 'annotation-3'));
}

// 7. 悬空互见引用在最终稿被清除
{
  const { doc, snapshot } = base();
  const local = withEdits(doc, (d) => {
    d.annotations.find((x) => x.id === 'annotation-1')!.body = '甲改引用';
    d.annotations.find((x) => x.id === 'annotation-1')!.references = ['annotation-404'];
  });
  const incoming = clone(base().doc);
  const plan = buildMergePlan({ baseSnapshot: snapshot, local, incoming });
  const out = finalizeMerge(plan, {}, { local, incoming });
  const a1 = out.annotations.find((x) => x.id === 'annotation-1')!;
  check('悬空互见被清除', !a1.references.includes('annotation-404'));
}

// 8. 同形词按出现序号定位；无法唯一定位时迁移到句子
{
  const mk = (): Sentence => ({
    id: 'sentence-x', order: 1,
    text: 'ABAC',
    tokens: [
      { id: 'a1', text: 'A' },
      { id: 'b1', text: 'B' },
      { id: 'a2', text: 'A' },
      { id: 'c1', text: 'C' }
    ]
  });
  const baseSentence = mk();
  // target 保留两个 A，可按序号定位第二个
  const target1: Sentence = JSON.parse(JSON.stringify(baseSentence));
  const r1 = relocateTokenAnchor({ baseSentence, targetSentence: target1, tokenId: 'a2' });
  check('同形词按出现序号定位', r1.anchorType === 'word' && r1.anchorId === 'a2', `got ${r1.anchorType}`);
  // target 只剩一个 A，无法唯一定位 → 迁句
  const target2 = {
    ...baseSentence,
    tokens: [
      { id: 'a1', text: 'A' },
      { id: 'b1', text: 'B' },
      { id: 'c1', text: 'C' }
    ]
  };
  const r2 = relocateTokenAnchor({ baseSentence, targetSentence: target2, tokenId: 'a2' });
  check('同形词不唯一时迁句', r2.anchorType === 'sentence');
}

console.log(failures ? `\n${failures} failures` : '\nall merge tests passed');
process.exit(failures ? 1 : 0);
