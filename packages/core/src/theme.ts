/**
 * 윤회(輪廻) flavour. retry-now is a parody of reincarnation: every iteration is a new
 * life (context reset to 0), and the loop ends only when the improvement is 맺어진다
 * (consummated) — i.e. N consecutive lives find nothing left to improve.
 */

import type { SnapshotFailure } from './repository-snapshot.ts'
import { VERSION } from './version.ts'

export const OATH = [
  '지금 바로 윤회!!! 맺어질 때까지 새끼손가락 걸고, 맹세해!',
  '다음 생에서는 꼭 맺어지자',
  '운명이여, 무릎 꿇어라',
] as const

// ASCII frame on purpose: box-drawing chars misalign against double-width Korean and render
// inconsistently on Windows code pages. Korean content renders fine; the frame stays ASCII.
export const BANNER = [
  '',
  `  retry-now v${VERSION}  |  지금 바로 윤회`,
  '  ---------------------------------------------',
  '  context dies each life; only the streak is reborn.',
  '  the loop ends when 맺어진다.',
].join('\n')

/** A new life begins — fresh session, zero memory. */
export function rebirth(iteration: number): string {
  return `◯ ${iteration}번째 생 (환생) — 기억 없는 새 세션`
}

/** The improvement was consummated; nothing left to improve. */
export function converged(threshold: number): string {
  return [
    `❤ 맺어졌다. ${threshold}생 연속 개선할 것이 없었다.`,
    `   "${OATH[1]}" → 이번 생에 맺어졌으니, 윤회를 멈춘다.`,
  ].join('\n')
}

/** Converged via reverts: the same change kept being proposed and reverted — nothing to keep. */
export function revertConverged(threshold: number): string {
  return [
    `❤ 맺어졌다. ${threshold}생 연속 윤회 전체가 리버트되었다(보존된 개선 없음).`,
    `   더 손댈 것이 없다고 인정하고, 윤회를 멈춘다.`,
  ].join('\n')
}

export function oathBlock(): string {
  return OATH.map((l) => `  ${l}`).join('\n')
}

/**
 * Why a Git-visible 스냅샷 could not be taken, in the user's language.
 *
 * The driver refuses to launch ANALYZE without a snapshot, so this line is the ENTIRE explanation the
 * user gets for a repository just declared unusable. It therefore names the measured cause — and the
 * offending path when there is one — instead of listing what the cause might have been: the previous
 * "충돌 상태 또는 서브모듈을 확인하세요" guess sent people hunting for conflicts and submodules that
 * did not exist, when the real cause was one unsafe path.
 */
export function snapshotFailure(failure: SnapshotFailure): string {
  switch (failure.reason) {
    case 'gitlink':
      return `서브모듈(gitlink) 항목이 포함되어 있습니다: ${failure.path}`
    case 'unsafe-path':
      return `안전하지 않은 저장소 경로가 있습니다: ${failure.path}`
    case 'head-moved':
      return '스냅샷을 만드는 동안 Git HEAD가 변경되었습니다.'
    case 'index-moved':
      return '스냅샷을 만드는 동안 Git 인덱스(staged tree)가 변경되었습니다.'
    case 'git-failed':
      return 'Git 명령이 실패했습니다(HEAD·인덱스·파일 목록 조회 실패).'
  }
}

/**
 * Commit-message prefix that ties a commit to a specific 윤회 (iteration). Multiple commits
 * can share one prefix, so the user can `git log --grep` a single life's full change set.
 */
export function commitPrefix(padded: string): string {
  return `retry-now#${padded}: `
}
