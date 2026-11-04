import 'dotenv/config';
import mysql from 'mysql2/promise';
export const pool = mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,charset:'utf8mb4',connectionLimit:10,timezone:'+08:00'});
export async function transaction(work) {
  const connection=await pool.getConnection();
  try {await connection.beginTransaction(); const result=await work(connection); await connection.commit(); return result;}
  catch(error){if(error.commitTransaction)await connection.commit();else await connection.rollback();throw error;} finally{connection.release();}
}
export async function audit(connection,actor,action,target,detail={}) {
  await connection.execute('INSERT INTO audit_logs(actor,action,target,detail) VALUES(?,?,?,?)',[actor,action,String(target),JSON.stringify(detail)]);
}
