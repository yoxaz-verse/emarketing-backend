export function classifyBounce(text: string) {
    const body = text.toLowerCase()
  
    if (
      body.includes('user does not exist') ||
      body.includes('no such user')
    ) {
      return 'hard'
    }
  
    if (
      body.includes('mailbox full') ||
      body.includes('temporary failure')
    ) {
      return 'soft'
    }
  
    return 'unknown'
  }
  