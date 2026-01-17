import { Request, Response } from 'express'
import { runEligibilityWorker } from '../../worker/email/eligibility.worker'

export async function runEmailEligibilityValidation(
  req: Request,
  res: Response
) {
  console.log("runEmailEligibilityValidation");
  
  // fire-and-forget worker
  runEligibilityWorker(100)

  return res.json({
    success: true,
    message: 'Email eligibility validation started'
  })
}
