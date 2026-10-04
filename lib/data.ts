import type {
  AnchorType,
  Annotation,
  AnnotationKind,
  Chapter,
  Sentence,
  TextDocument,
  TextToken,
  VersionSnapshot
} from './types';

const FIXED_TIME = '2026-09-25T02:00:00.000Z';
let tokenSequence = 0;

function canUseSegmenter() {
  return typeof Intl !== 'undefined' && 'Segmenter' in Intl;
}

export function tokenizeText(text: string, sentenceId: string, existing: TextToken[] = []): TextToken[] {
  let parts: string[] = [];
  if (canUseSegmenter()) {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter: new (locale: string, options: { granularity: string }) => {
        segment: (value: string) => Iterable<{ segment: string }>;
      };
    }).Segmenter;
    parts = Array.from(new Segmenter('zh-CN', { granularity: 'word' }).segment(text), (item) => item.segment);
  } else {
    parts = text.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+|\s+|[^\s]/gu) ?? [text];
  }

  const used = new Set<number>();
  return parts.map((part, index) => {
    const matchedIndex = existing.findIndex(
      (token, tokenIndex) => !used.has(tokenIndex) && token.text === part
    );
    if (matchedIndex >= 0) {
      used.add(matchedIndex);
      return existing[matchedIndex];
    }
    tokenSequence += 1;
    return {
      id: `${sentenceId}-token-${index}-${tokenSequence.toString(36)}`,
      text: part
    };
  });
}

function sentence(id: string, order: number, text: string): Sentence {
  return { id, order, text, tokens: tokenizeText(text, id) };
}

const chapters: Chapter[] = [
  {
    id: 'chapter-1',
    order: 1,
    title: '逍遥游',
    summary: '大与小、有待与无待的层层对照。',
    sentences: [
      sentence('sentence-1-1', 1, '北冥有鱼，其名为鲲。'),
      sentence('sentence-1-2', 2, '鲲之大，不知其几千里也。'),
      sentence('sentence-1-3', 3, '化而为鸟，其名为鹏。'),
      sentence('sentence-1-4', 4, '鹏之背，不知其几千里也；怒而飞，其翼若垂天之云。'),
      sentence('sentence-1-5', 5, '是鸟也，海运则将徙于南冥。'),
      sentence('sentence-1-6', 6, '南冥者，天池也。')
    ]
  },
  {
    id: 'chapter-2',
    order: 2,
    title: '齐物论',
    summary: '齐是非、同彼我，讨论言语与成心的边界。',
    sentences: [
      sentence('sentence-2-1', 1, '夫言非吹也，言者有言。'),
      sentence('sentence-2-2', 2, '其所言者特未定也。'),
      sentence('sentence-2-3', 3, '果有言邪？其未尝有言邪？'),
      sentence('sentence-2-4', 4, '其以为异于鷇音，亦有辩乎？'),
      sentence('sentence-2-5', 5, '其无辩乎？道恶乎隐而有真伪？')
    ]
  },
  {
    id: 'chapter-3',
    order: 3,
    title: '秋水',
    summary: '河伯与北海若的问答，展开大小、贵贱与时势之辨。',
    sentences: [
      sentence('sentence-3-1', 1, '秋水时至，百川灌河。'),
      sentence('sentence-3-2', 2, '泾流之大，两涘渚崖之间，不辩牛马。'),
      sentence('sentence-3-3', 3, '于是焉河伯欣然自喜，以天下之美为尽在己。'),
      sentence('sentence-3-4', 4, '顺流而东行，至于北海，东面而视，不见水端。'),
      sentence('sentence-3-5', 5, '于是焉河伯始旋其面目，望洋向若而叹。')
    ]
  }
];

function tokenId(chapter: number, sentenceIndex: number, index: number) {
  return `sentence-${chapter}-${sentenceIndex + 1}-token-${index}`;
}

function findTokenId(sentenceId: string, text: string) {
  const target = chapters.flatMap((chapter) => chapter.sentences).find((item) => item.id === sentenceId);
  return target?.tokens.find((token) => token.text.includes(text))?.id ?? target?.id ?? sentenceId;
}

const pengId = findTokenId('sentence-1-3', '鹏');
const mingId = findTokenId('sentence-1-1', '北冥');
const bianId = findTokenId('sentence-3-2', '辩');

const annotations: Annotation[] = [
  {
    id: 'annotation-1',
    anchorId: chapters[0].sentences[0].id,
    anchorType: 'sentence',
    kind: 'footnote',
    title: '北冥',
    body: '冥，一作溟。指北方荒远、幽深之地，不必拘定为具体海域。',
    source: '郭庆藩本',
    references: ['annotation-2'],
    status: 'open',
    tags: ['地理', '通假'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-2',
    anchorId: chapters[0].sentences[0].id,
    anchorType: 'sentence',
    kind: 'footnote',
    title: '北冥（异说）',
    body: '“冥”可径释为海。北冥即北海，语意直截，不烦引申。',
    source: '王先谦本',
    references: ['annotation-1'],
    status: 'open',
    tags: ['地理'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-3',
    anchorId: pengId,
    anchorType: 'word',
    kind: 'variant',
    title: '鹏字异文',
    body: '《世德堂》本作“凤”，敦煌残卷或作“朋”。据上下文及早期类书，多用“鹏”。',
    source: '校勘组',
    references: ['annotation-4'],
    status: 'open',
    tags: ['异文', '字形'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-4',
    anchorId: pengId,
    anchorType: 'word',
    kind: 'background',
    title: '鹏的意象',
    body: '鹏由鲲化，象征由有限向无限转化的想象尺度。',
    source: '阅读笺注',
    references: [],
    status: 'open',
    tags: ['意象'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-5',
    anchorId: mingId,
    anchorType: 'word',
    kind: 'crossref',
    title: '北冥见后文',
    body: '“北冥”与后文“南冥”构成空间对举。',
    source: '结构注',
    references: ['annotation-1'],
    status: 'open',
    tags: ['互见'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-6',
    anchorId: chapters[1].sentences[2].id,
    anchorType: 'sentence',
    kind: 'background',
    title: '连续设问',
    body: '三句设问并非要求事实答案，而是动摇“言必有定指”的预设。',
    source: '讲义稿',
    references: [],
    status: 'open',
    tags: ['义理'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-7',
    anchorId: chapters[1].sentences[3].id,
    anchorType: 'sentence',
    kind: 'variant',
    title: '鷇音',
    body: '鷇音指雏鸟待哺之声。旧注或释为鸟鸣，义可并存。',
    source: '成玄英疏',
    references: [],
    status: 'resolved',
    tags: ['异文', '训诂'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-8',
    anchorId: bianId,
    anchorType: 'word',
    kind: 'variant',
    title: '辩 / 辨',
    body: '此处“不辩牛马”与下章“亦有辩乎”字形互见。取“分别、辨别”之义时，“辨”更显，但底本保留“辩”。',
    source: '底本保留',
    references: [],
    status: 'open',
    tags: ['异体字'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  },
  {
    id: 'annotation-9',
    anchorId: chapters[2].sentences[2].id,
    anchorType: 'sentence',
    kind: 'crossref',
    title: '与《齐物论》对读',
    body: '“天下之美为尽在己”可与《齐物论》“成心”之说对读。',
    source: '专题校记',
    references: ['annotation-6'],
    status: 'open',
    tags: ['互见'],
    conflictState: 'open',
    updatedAt: FIXED_TIME
  }
];

const initialSnapshot: VersionSnapshot = {
  id: 'snapshot-base',
  label: '整理底本 v1',
  note: '初始整理稿，保留底本用字并录入首批校注。',
  createdAt: FIXED_TIME,
  chapters: structuredClone(chapters),
  annotations: structuredClone(annotations)
};

export const initialDocument: TextDocument = {
  id: 'zhuangzi-selection',
  title: '《庄子》内篇选注',
  author: '庄周（公版整理）',
  edition: '整理底本',
  chapters,
  annotations,
  snapshots: [initialSnapshot],
  updatedAt: FIXED_TIME
};

export const annotationKindLabels: Record<AnnotationKind, string> = {
  footnote: '脚注',
  variant: '异文',
  background: '背景说明',
  crossref: '交叉引用'
};

export const anchorTypeLabels: Record<AnchorType, string> = {
  chapter: '章节',
  sentence: '句子',
  word: '词语'
};
