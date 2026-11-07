import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  throw new Error('Demo data seeding is disabled in production.');
}

const workers = [
  ['u_worker1', 'Priyanka Das', 'worker@vaxreach.demo', '+91 674 555 0102', 'Salia Sahi UHC (DEMO)'],
  ['u_worker2', 'Suresh Behera', 'worker2@vaxreach.demo', '+91 674 555 0103', 'Bidanasi UHC (DEMO)'],
  ['u_worker3', 'Kabita Nayak', 'worker3@vaxreach.demo', '+91 674 555 0113', 'Puri District Hospital (DEMO)']
];
const households = [
  ['h_1','Sasmita Panda','+91 674 555 0104','Salia Sahi','Khordha','Salia Sahi, Bhubaneswar',20.2961,85.8194],
  ['h_2','Rakesh Mohanty','+91 674 555 0105','Bidanasi','Cuttack','Bidanasi, Cuttack',20.4820,85.8650],
  ['h_3','Sudha Sahu','+91 674 555 0106','Bidanasi','Cuttack','Malgodown, Cuttack',20.4780,85.8720],
  ['h_4','Rina Jena','+91 674 555 0107','Salia Sahi','Khordha','Salia Sahi, Sector 2',20.2980,85.8220],
  ['h_5','Debashis Nayak','+91 674 555 0108','Niladri Vihar','Khordha','Niladri Vihar, Bhubaneswar',20.3010,85.8330],
  ['h_6','Mamata Pradhan','+91 674 555 0109','Puri Sahi','Puri','Puri Sahi, Puri',19.8135,85.8312],
  ['h_7','Sukanta Rout','+91 674 555 0110','Khetrajpur','Sambalpur','Khetrajpur, Sambalpur',21.4669,83.9812],
  ['h_8','Anita Padhi','+91 674 555 0111','Gosani Nuagaon','Ganjam','Gosani Nuagaon, Berhampur',19.3150,84.7941],
  ['h_9','Bikash Mohapatra','+91 674 555 0112','Rourkela','Sundargarh','Civil Township, Rourkela',22.2604,84.8536],
  ['h_10','Pravati Das','+91 674 555 0114','Balasore','Balasore','Sahadevkhunta, Balasore',21.4934,86.9335]
];
const children = [
  ['c_1','Aditya Panda',130,'Male','u_child1','h_1','u_worker1'],
  ['c_2','Aahana Panda',45,'Female','u_child3','h_1','u_worker1'],
  ['c_3','Bibhu Mohanty',240,'Male','u_child2','h_2','u_worker2'],
  ['c_4','Riya Sahu',390,'Female','u_child4','h_3','u_worker2'],
  ['c_5','Sohan Jena',20,'Male','u_child5','h_4','u_worker1'],
  ['c_6','Ananya Nayak',610,'Female','u_child6','h_5','u_worker1'],
  ['c_7','Dibya Pradhan',100,'Female','u_child7','h_6','u_worker3'],
  ['c_8','Ipsita Rout',330,'Female','u_child8','h_7','u_worker2'],
  ['c_9','Omkar Padhi',70,'Male','u_child9','h_8','u_worker1'],
  ['c_10','Subham Mohapatra',180,'Male','u_child10','h_9','u_worker2'],
  ['c_11','Sneha Das',220,'Female','u_child11','h_10','u_worker3']
];
const vaccines = [
  ['BCG',0],['HepB0',0],['OPV0',0],['OPV1',42],['PENTA1',42],['PCV1',42],['ROTA1',42],
  ['OPV2',70],['PENTA2',70],['PCV2',70],['ROTA2',70],['OPV3',98],['PENTA3',98],['PCV3',98],['IPV',98],['MR1',274],['MR2',456]
];

function dateOffset(base, days) {
  const date = new Date(`${base}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function childEmail(id) {
  if (id === 'c_1') return 'child@vaxreach.demo';
  if (id === 'c_2') return 'aahana@vaxreach.demo';
  if (id === 'c_3') return 'child2@vaxreach.demo';
  return `${id}@vaxreach.demo`;
}

try {
  const adminHash = await bcrypt.hash('admin123', 12);
  await pool.query(`INSERT INTO users(id,name,email,email_normalized,password_hash,role,phone,facility)
    VALUES('u_admin','Dr. Anjali Patnaik','admin@vaxreach.demo','admin@vaxreach.demo',$1,'admin','+91 674 555 0101','Odisha HFW (DEMO)')
    ON CONFLICT(id) DO NOTHING`, [adminHash]);

  const workerHash = await bcrypt.hash('worker123', 12);
  for (const [id,name,email,phone,facility] of workers) {
    await pool.query(`INSERT INTO users(id,name,email,email_normalized,password_hash,role,phone,facility)
      VALUES($1,$2,$3,lower($3),$4,'worker',$5,$6) ON CONFLICT(id) DO NOTHING`,
    [id,name,email,workerHash,phone,facility]);
  }

  const childHash = await bcrypt.hash('child123', 12);
  for (const [id,name,ageDays,sex,accountId,householdId,workerId] of children) {
    const email = childEmail(id);
    await pool.query(`INSERT INTO users(id,name,email,email_normalized,password_hash,role,phone,facility)
      VALUES($1,$2,$3,lower($3),$4,'child',$5,'') ON CONFLICT(id) DO NOTHING`,
    [accountId,name,email,childHash,households.find(household=>household[0]===householdId)[2]]);
  }

  for (const [id,head,phone,community,district,address,lat,lng] of households) {
    await pool.query(`INSERT INTO households(id,head,phone,community,district,address,lat,lng)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
    [id,head,phone,community,district,address,lat,lng]);
  }

  const today = (await pool.query("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0].today;
  for (const [id,name,ageDays,sex,accountId,householdId,workerId] of children) {
    const household = households.find(item=>item[0]===householdId);
    const dob = dateOffset(today, -ageDays);
    await pool.query(`INSERT INTO children(id,unique_id,name,dob,sex,account_id,household_id,assigned_worker_id,guardian_name,phone,community,district)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
    [id,`VR-DEMO-${String(Number(id.slice(2))).padStart(3,'0')}`,name,dob,sex,accountId,householdId,workerId,household[1],household[2],household[3],household[4]]);
    for (const [code,age] of vaccines) {
      const dueDate = dateOffset(dob, age);
      const status = dueDate < today ? 'overdue' : 'due';
      await pool.query(`INSERT INTO vaccination_schedules(id,child_id,vaccine_code,due_date,status,source)
        VALUES($1,$2,$3,$4,$5,'Demo seeded') ON CONFLICT(id) DO NOTHING`,
      [`s_${id}_${code}`,id,code,dueDate,status]);
    }
  }
  console.log('Development demo accounts, children, and schedules are ready.');
} finally {
  await pool.end();
}
