import { runAutomationsForTrigger } from '@/lib/automations/engine'

export async function notifyDealCreated(params: {
  accountId: string
  dealId: string
  contactId?: string | null
  pipelineId: string
  stageId: string
  title: string
  value?: number
}): Promise<void> {
  try {
    await runAutomationsForTrigger({
      accountId: params.accountId,
      triggerType: 'deal_created',
      contactId: params.contactId ?? null,
      context: {
        deal_id: params.dealId,
        pipeline_id: params.pipelineId,
        stage_id: params.stageId,
        vars: {
          deal_title: params.title,
          deal_value: params.value ?? 0,
        },
      },
    })
  } catch (err) {
    console.error('[deals] notifyDealCreated error:', err)
  }
}

export async function notifyDealStageChanged(params: {
  accountId: string
  dealId: string
  contactId?: string | null
  pipelineId: string
  oldStageId?: string
  newStageId: string
}): Promise<void> {
  try {
    await runAutomationsForTrigger({
      accountId: params.accountId,
      triggerType: 'deal_stage_changed',
      contactId: params.contactId ?? null,
      context: {
        deal_id: params.dealId,
        pipeline_id: params.pipelineId,
        stage_id: params.newStageId,
        old_stage_id: params.oldStageId,
      },
    })
  } catch (err) {
    console.error('[deals] notifyDealStageChanged error:', err)
  }
}
