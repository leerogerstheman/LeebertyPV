/* LeebertyPV · 设计理念页：为什么这个工作台长这样。
 *
 * 把系统背后"可辩护的药物警戒工作"理念直白地摆出来——每条理念都指向
 * 一个具体的界面行为，而不是一句口号。理念页对所有人公开（无需登录），
 * 因为"我们为什么这样工作"本来就是给整个团队看的。
 */
(function () {
  'use strict';

  const { t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card } = U;

  const ONE_LINER = {
    zh: '个例报告是原料，时限是底线，信号是线索，获益-风险评估才是结论。',
    en: 'Case reports are the raw material, timelines are the floor, signals are the clues - benefit-risk assessment is the conclusion.',
  };

  const PRINCIPLES = [
    {
      id: 'timeline',
      zh: '时限从首次获知起算',
      en: 'The clock starts at first knowledge',
      bodyZh: '报告时限从首次获知任一四要素信息之日（Day 0）起算，而不是从病例"做完"那天起算。系统在受理步骤就要求记录接收日期，后续每一步都可见距时限还剩几天。',
      bodyEn: 'The reporting timeline starts the day any of the four elements is first known (Day 0), not the day the case is "finished". The intake step records the receipt date, and every later step shows the days left to deadline.',
    },
    {
      id: 'four-elements',
      zh: '四要素是有效个例的最低门槛',
      en: 'Four elements are the floor for a valid case',
      bodyZh: '可识别的患者、可识别的报告者、可疑药品、不良事件——四要素缺一不能构成有效个例报告。录入界面强制核对，缺失信息通过随访补齐，但补齐不得延误报告。',
      bodyEn: 'An identifiable patient, an identifiable reporter, a suspect product and an adverse event - without all four there is no valid ICSR. The entry form forces the check; missing data is chased by follow-up, not by delaying the report.',
    },
    {
      id: 'causality',
      zh: '因果评价记录依据，而非只给结论',
      en: 'Causality records its basis, not just a conclusion',
      bodyZh: 'WHO-UMC 六级分类是一种判断框架，不是掷硬币。医学评价员必须写下时间相关性、生物学合理性等判断依据；依据进审计追踪，检查员可以重建当时的推理。',
      bodyEn: 'The WHO-UMC six-level scale is a judgement framework, not a coin flip. The medical assessor must record the grounds - timing, biological plausibility - and the basis enters the audit trail where an inspector can rebuild the reasoning.',
    },
    {
      id: 'report-first',
      zh: '先保证报告，再追求完整',
      en: 'Report first, perfect later',
      bodyZh: '随访信息不足时，个体化判断可以"待补充"结案，但严重且非预期的报告必须在法定时限内提交。系统把"是否在时限内提交"作为提交步骤的必答项。',
      bodyEn: 'A case may close with follow-up pending, but a serious, unexpected reaction must be submitted within the legal timeline. "Submitted within timeline?" is a required field on the submission step.',
    },
    {
      id: 'signal',
      zh: '信号管理是获益-风险评估的引擎',
      en: 'Signal management is the benefit-risk engine',
      bodyZh: '个例报告是原料，比例失衡（PRR/ROR/EBGM）是线索，医学判断才是结论。信号从检测到处置的每一步都有角色门：提出人不能自己关闭自己检测出的高风险信号。',
      bodyEn: 'Case reports are the raw material, disproportionality (PRR/ROR/EBGM) is the clue, medical judgement is the conclusion. Every signal step has a role gate: the person who raised a high-risk signal cannot close it alone.',
    },
    {
      id: 'separation',
      zh: '录入的人不能同时是评价的人',
      en: 'The person who enters must not be the person who assesses',
      bodyZh: '数据录入员、医学评价员、审批人各持不同权限。职责分离是代码强制的：录入员没有因果关系评价权限，提交后不可自行撤销，任何改动都要理由与签名。',
      bodyEn: 'Data entry, medical assessment and approval carry distinct permissions. Separation of duties is enforced in code: a coder holds no causality permission, submissions cannot be silently undone, and every change needs a reason and a signature.',
    },
    {
      id: 'trace',
      zh: '每一份报告都可追溯到它的一生',
      en: 'Every report is traceable for its whole life',
      bodyZh: '哈希链审计追踪 + 电子签名 + 修改理由，让"谁、何时、为何、改了什么"永远可查。个例报告一旦归档不可覆写；随访作为新版本进入同一记录。',
      bodyEn: 'A hash-chained audit trail, electronic signatures and change reasons keep "who, when, why, what" permanently answerable. A case is never overwritten; follow-up arrives as a new version of the same record.',
    },
    {
      id: 'readiness',
      zh: '检查就绪度是常态，不是突击',
      en: 'Inspection readiness is a routine, not a scramble',
      bodyZh: '自查把 GVP 与 81号令条款变成可判定的检查项，发现的缺陷一键转 CAPA；未关闭缺陷、超期时限、培训过期、审计链完整性汇成一个就绪度评分并列出具体阻碍项。',
      bodyEn: 'Self-inspection turns GVP clauses and Order 81 into assessable checks; a gap becomes a CAPA in one click. Open findings, missed deadlines, expired training and audit chain integrity roll into one readiness score with named blockers.',
    },
  ];

  const view = {
    routes: [{ pattern: '/philosophy' }],
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const data = await window.Api.get('/api/philosophy');
      clear(container);

      const en = getLocale() === 'en';
      const phi = data && data.philosophy ? data.philosophy : {};
      const phiEn = data && data.philosophyEn ? data.philosophyEn : {};
      const areas = (data && data.areas) || [];

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('nav.philosophy')),
            el('p.view-sub', {}, bilingual(
              '把工作台背后的判断直白地写出来：每条理念都对应一个具体功能',
              'The reasoning behind this workbench, plainly stated: every principle maps to a concrete feature'
            )),
          ]),
        ]),

        el('div.philosophy-quote', {}, [
          el('strong', {}, en ? ONE_LINER.en : ONE_LINER.zh),
        ]),

        el('h2.section-title', {}, bilingual('核心原则 / 为什么这样工作', 'Core principles / why we work this way')),
        el('div.philosophy-grid', {}, PRINCIPLES.map((p) => el('div.philosophy-block', {}, [
          el('div.philosophy-key', {}, en ? p.en : p.zh),
          el('div.philosophy-body', {}, en ? p.bodyEn : p.bodyZh),
        ]))),

        el('h2.section-title', {}, bilingual('领域理念 / 八个专业领域各自的工作哲学', 'Domain philosophies / how each discipline thinks')),
        el('div.philosophy-grid', {}, areas.map((a) => el('div.philosophy-block', {}, [
          el('div.philosophy-key', {}, `${a.code} · ${en ? a.nameEn : a.name}`),
          el('div.philosophy-body', {}, en ? (phiEn[a.code] || a.descriptionEn || a.description) : (phi[a.code] || a.description)),
        ]))),

        card('', el('p.muted', {}, bilingual(
          '这些理念不是装饰——它们被写进了工作流定义、角色权限和代码强制约束。你可以在「领域与流程」中逐条看到它们如何落地。',
          'These are not decoration: they are written into the workflow definitions, the role permissions and the code-enforced constraints. See how each one lands in Domains & Workflows.'
        ))),
      ]));
    },
  };

  window.Views.register('philosophy', view);
})();