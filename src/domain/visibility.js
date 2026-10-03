'use strict';

/**
 * Who may see what about whom.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * An earlier design put roles into levels - 1 for an overall manager, 2 for a
 * domain manager - and let a higher level see everyone below it. That was
 * rejected, and the reason is worth keeping next to the code that replaced it:
 * GxP does not organise authority by rank. The kernel already enforces that a QA
 * manager cannot close a record they authored, and that an administrator cannot
 * be the sole approver of anything. A rank model reintroduces exactly the
 * inference those rules exist to prevent - that a senior person may review a
 * junior person's work.
 *
 * So visibility is derived from FUNCTIONAL RELATIONSHIP, not seniority:
 *
 *   1. WORKING IN THE AREA   - if the area is one of your home areas, you see
 *                              every role in it. This is the team you work with:
 *                              a study director knowing who the QA specialist is
 *                              is not a disclosure, it is the job.
 *
 *   2. RESPONSIBLE FOR THE   - QA, internal audit, the qualified person and
 *      AREA ACROSS DOMAINS     training see across areas, because their function
 *                              is defined across areas. This is a named, reasoned
 *                              grant rather than a rank: it appears in the
 *                              permission matrix and can be shown to an inspector.
 *
 *   3. EVERYONE ELSE         - the role's NAME, duties and permissions are public
 *                              reference material, because a GxP process diagram
 *                              that hides its own roles is useless. What is not
 *                              public is the person: the account holder, their
 *                              workload, and their records.
 *
 * WHAT THIS DELIBERATELY DOES NOT GOVERN
 * --------------------------------------
 * Access to the records themselves. That is decided by the permission set
 * (`record.view`, `subject.view`, ...) and by the code-enforced constraints, both
 * of which already exist and both of which are enforced server-side. This module
 * answers a narrower question: which PERSONS a role may see described. Conflating
 * the two would produce a second, competing access model.
 *
 * Every decision carries its reason so the interface can explain a refusal rather
 * than simply denying it - an unexplained "no" in a compliance tool teaches
 * nothing and gets worked around.
 */

const config = require('../config');

/** Roles whose function is defined across the whole pharmacovigilance system. */
const CROSS_DOMAIN = {
  qa_manager: '质量体系覆盖全部领域；没有 QA 的领域不构成受控的 PV 体系',
  qa_specialist: '执行调查、文件与整改跟踪，服务于所有领域',
  qa_auditor: '内审范围必须覆盖全部 PV 领域（GVP Module I / ICH Q10）',
  trainer: '培训与资质对每个领域一致适用',
  auditor_external: '监管检查员可检查任何领域，且其查看行为本身留痕',
};

/** How far a viewer can see, in increasing order of reach. */
const SCOPE = {
  public: 'public',            // role name, duties and permissions only
  own_area: 'own_area',        // plus every person in their own areas
  cross_domain: 'cross_domain', // plus people in areas their function covers
};

/**
 * How far a role can see.
 *
 * @param {string} role
 * @param {string[]} homeAreas  the areas this role works in
 * @returns {{scope: string, reason: string, reasonEn: string}}
 */
function scopeFor(role, homeAreas = []) {
  if (CROSS_DOMAIN[role]) {
    return {
      scope: SCOPE.cross_domain,
      reason: CROSS_DOMAIN[role],
      reasonEn: `Cross-domain function: ${role}`,
    };
  }
  if (role === 'system_admin') {
    // No process role at all. Administrative access to the instance is not the
    // same as a licence to read people's safety work, so the scope stays narrow.
    return {
      scope: SCOPE.public,
      reason: '系统管理员不承担 PV 流程职责，不因技术权限而获得记录可见范围',
      reasonEn: 'A system administrator holds no PV process role; technical access does not grant record visibility',
    };
  }
  if (homeAreas.length) {
    return {
      scope: SCOPE.own_area,
      reason: `在 ${homeAreas.join('、')} 中承担流程职责，可见本领域全部岗位`,
      reasonEn: `Carries process responsibility in ${homeAreas.join(', ')}, so sees every role in those areas`,
    };
  }
  return {
    scope: SCOPE.public,
    reason: '未承担具体领域的流程职责，只能查看岗位名称、职责与权限',
    reasonEn: 'No process responsibility in any area, so only the role name, duties and permissions are visible',
  };
}

/**
 * May `viewerRole` see the person behind `targetRole`?
 *
 * @param {{role: string, homeAreas: string[]}} viewer
 * @param {{role: string, homeAreas: string[], area?: string}} target
 * @returns {{allowed: boolean, scope: string, reason: string}}
 */
function canSeePerson(viewer, target) {
  const scope = scopeFor(viewer.role, viewer.homeAreas || []);

  if (scope.scope === SCOPE.cross_domain) {
    return {
      allowed: true,
      scope: scope.scope,
      reason: `${scope.reason}，因此可见其他领域的岗位人员`,
      reasonEn: `${scope.reasonEn}, so people in other areas are visible`,
    };
  }

  if (scope.scope === SCOPE.own_area) {
    const shared = (target.homeAreas || []).filter((a) => (viewer.homeAreas || []).includes(a));
    if (shared.length) {
      return {
        allowed: true,
        scope: scope.scope,
        reason: `与对方同在 ${shared.join('、')} 工作`,
        reasonEn: `Works in the same area: ${shared.join(', ')}`,
      };
    }
    if (target.area && (viewer.homeAreas || []).includes(target.area)) {
      return {
        allowed: true,
        scope: scope.scope,
        reason: `在本领域（${target.area}）内，可见该领域全部岗位`,
        reasonEn: `Inside your own area (${target.area}); every role in it is visible`,
      };
    }
    return {
      allowed: false,
      scope: scope.scope,
      reason: `你只在 ${(viewer.homeAreas || []).join('、') || '（无）'} 中承担职责，`
        + `看不到其他领域的人员信息。岗位职责与权限仍然公开。`,
      reasonEn: `You carry responsibility only in ${(viewer.homeAreas || []).join(', ') || '(none)'}, `
        + 'so people in other areas are not visible. Role duties and permissions remain public.',
    };
  }

  return {
    allowed: false,
    scope: scope.scope,
    reason: `${scope.reason}。岗位名称、职责与权限对所有人公开，但具体人员不公开。`,
    reasonEn: `${scope.reasonEn}. The role name, duties and permissions are public; the person is not.`,
  };
}

/**
 * May `viewerRole` see the WORKLOAD of `targetRole`?
 *
 * Separate from seeing the person, because a workload count is a fact about the
 * organisation rather than about the role: how many deviations a site has open is
 * not disclosed by knowing that a QA manager exists. Only a viewer who works in
 * the area, or whose function covers it, is given the number.
 */
function canSeeWorkload(viewer, target) {
  const person = canSeePerson(viewer, target);
  if (person.allowed) return person;
  return {
    allowed: false,
    scope: person.scope,
    reason: person.reason,
    reasonEn: person.reasonEn,
  };
}

/** Is the demonstration instance publishing its cast at all? */
function castIsPublic() {
  return Boolean(config.features.builtinAccounts);
}

module.exports = {
  SCOPE,
  CROSS_DOMAIN,
  scopeFor,
  canSeePerson,
  canSeeWorkload,
  castIsPublic,
};
