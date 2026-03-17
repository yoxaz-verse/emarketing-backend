import { listRows } from './src/services/crudService';
import * as dotenv from 'dotenv';

dotenv.config();

async function test() {
  try {
    console.log('Testing campaigns list...');
    const data = await listRows('campaigns' as any);
    console.log('Data:', data);
  } catch (err: any) {
    console.error('Error:', err);
  }
}

test();
