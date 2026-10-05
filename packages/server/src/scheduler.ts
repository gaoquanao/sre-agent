import { Cron } from 'croner'
import type { ScheduleSpec } from '@sre/protocol'
import type { Logger } from './log.ts'
import type { RunbookRunner } from './runbooks.ts'
import type { Store } from './store.ts'

export interface SchedulerDeps {
  store: Store
  log: Logger
  runner: RunbookRunner
  onFire(scheduleId: string, runId: string, nextRunAt?: number): void
}

/**
 * Cron scheduling for runbooks. Jobs are in-process (`croner`), which keeps the
 * deployment to a single service; a schedule that fires while the previous run
 * is still going is skipped rather than stacked.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps
  private readonly jobs = new Map<string, Cron>()
  private readonly running = new Set<string>()
  private started = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  start(): void {
    this.started = true
    for (const schedule of this.deps.store.listSchedules()) {
      if (schedule.enabled) this.arm(schedule)
    }
    this.deps.log.info(`scheduler started with ${this.jobs.size} active schedule(s)`)
  }

  stop(): void {
    this.started = false
    for (const [, job] of this.jobs) job.stop()
    this.jobs.clear()
  }

  /** Create or replace a schedule job. */
  refresh(schedule: ScheduleSpec): { ok: boolean; detail: string; nextRunAt?: number } {
    this.disarm(schedule.id)
    if (!schedule.enabled) {
      this.deps.store.upsertSchedule({ ...schedule, nextRunAt: undefined })
      return { ok: true, detail: 'schedule disabled' }
    }
    const job = this.arm(schedule)
    if (job === undefined) return { ok: false, detail: `invalid cron expression: ${schedule.cron}` }
    return {
      ok: true,
      detail: 'schedule armed',
      ...(job.nextRun() === null ? {} : { nextRunAt: job.nextRun()?.getTime() }),
    }
  }

  remove(id: string): void {
    this.disarm(id)
  }

  nextRunAt(id: string): number | undefined {
    const next = this.jobs.get(id)?.nextRun()
    return next === null || next === undefined ? undefined : next.getTime()
  }

  private arm(schedule: ScheduleSpec): Cron | undefined {
    try {
      const job = new Cron(
        schedule.cron,
        {
          ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
          name: schedule.id,
          protect: true,
          unref: true,
        },
        () => {
          void this.fire(schedule.id)
        },
      )
      this.jobs.set(schedule.id, job)
      const next = job.nextRun()
      this.deps.store.upsertSchedule({
        ...schedule,
        ...(next === null ? {} : { nextRunAt: next.getTime() }),
      })
      this.deps.log.info(`schedule ${schedule.id} armed: ${schedule.cron} next=${next?.toISOString() ?? 'never'}`)
      return job
    } catch (error) {
      this.deps.log.warn(`schedule ${schedule.id} has an invalid cron expression "${schedule.cron}": ${String(error)}`)
      return undefined
    }
  }

  private disarm(id: string): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    job.stop()
    this.jobs.delete(id)
  }

  private async fire(scheduleId: string): Promise<void> {
    if (!this.started) return
    if (this.running.has(scheduleId)) {
      this.deps.log.warn(`schedule ${scheduleId} still running from the previous tick; skipping this fire`)
      return
    }
    const schedule = this.deps.store.listSchedules().find((entry) => entry.id === scheduleId)
    if (schedule === undefined || !schedule.enabled) return

    this.running.add(scheduleId)
    const startedAt = Date.now()
    try {
      const run = await this.deps.runner.run(schedule.runbookId, { trigger: 'schedule' })
      const next = this.nextRunAt(scheduleId)
      this.deps.store.markScheduleRun(scheduleId, startedAt, next)
      this.deps.onFire(scheduleId, run.id, next)
      this.deps.log.info(`schedule ${scheduleId} fired -> run ${run.id} (${run.status})`)
    } catch (error) {
      this.deps.log.error(`schedule ${scheduleId} failed to fire`, error)
    } finally {
      this.running.delete(scheduleId)
    }
  }
}
