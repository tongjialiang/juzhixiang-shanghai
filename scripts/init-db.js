import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
const options={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:'root',multipleStatements:true};
let connection;
try{connection=await mysql.createConnection({...options,password:process.env.DB_ROOT_PASSWORD});}
catch(error){if(error.code!=='ER_ACCESS_DENIED_ERROR')throw error; connection=await mysql.createConnection(options); await connection.query('ALTER USER CURRENT_USER() IDENTIFIED BY ?',[process.env.DB_ROOT_PASSWORD]);}
const database=process.env.DB_NAME;
if(!/^[a-z_]+$/.test(database))throw new Error('数据库名称不合法');
await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await connection.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',[process.env.DB_USER,'localhost',process.env.DB_PASSWORD]);
await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* TO ?@?`,[process.env.DB_USER,'localhost']);
await connection.changeUser({database,password:process.env.DB_ROOT_PASSWORD});
await connection.query(`
CREATE TABLE IF NOT EXISTS event_settings(id INT PRIMARY KEY, config JSON NOT NULL);
CREATE TABLE IF NOT EXISTS applications(
 id CHAR(36) PRIMARY KEY, code VARCHAR(32) UNIQUE NOT NULL, access_hash CHAR(64) NOT NULL,
 type VARCHAR(20) NOT NULL, name VARCHAR(80) NOT NULL, mobile VARCHAR(20) NOT NULL,
 status VARCHAR(32) NOT NULL, review_source VARCHAR(12), reasons JSON NOT NULL, profile JSON NOT NULL,
 topics JSON NOT NULL, question TEXT, consent JSON NOT NULL, channel VARCHAR(100),
 seat_count INT NOT NULL, reserved_until DATETIME, fee_cents INT, fee_authorized BOOLEAN DEFAULT FALSE,
 analysis JSON, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX(status), INDEX(mobile), INDEX(created_at));
CREATE TABLE IF NOT EXISTS orders(
 id CHAR(36) PRIMARY KEY, application_id CHAR(36) NOT NULL, amount_cents INT NOT NULL,
 status VARCHAR(24) NOT NULL, expires_at DATETIME NOT NULL, paid_at DATETIME, provider VARCHAR(24) NOT NULL,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(application_id) REFERENCES applications(id), INDEX(application_id));
CREATE TABLE IF NOT EXISTS tickets(
 id CHAR(36) PRIMARY KEY, application_id CHAR(36) UNIQUE NOT NULL, order_id CHAR(36) UNIQUE NOT NULL,
 token VARCHAR(100) UNIQUE NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'VALID',
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(application_id) REFERENCES applications(id), FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE TABLE IF NOT EXISTS ticket_members(
 id CHAR(36) PRIMARY KEY,ticket_id CHAR(36) NOT NULL,slot INT NOT NULL,label VARCHAR(100) NOT NULL,
 checked_at DATETIME,checked_by VARCHAR(80),FOREIGN KEY(ticket_id) REFERENCES tickets(id),UNIQUE(ticket_id,slot));
CREATE TABLE IF NOT EXISTS admin_users(id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(80) UNIQUE NOT NULL,password_hash VARCHAR(100) NOT NULL,role VARCHAR(24) NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash CHAR(64) PRIMARY KEY,user_id INT NOT NULL,expires_at DATETIME NOT NULL,FOREIGN KEY(user_id) REFERENCES admin_users(id));
CREATE TABLE IF NOT EXISTS application_access(token_hash CHAR(64) PRIMARY KEY,application_id CHAR(36) NOT NULL,expires_at DATETIME NOT NULL,FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sms_codes(id CHAR(36) PRIMARY KEY,mobile VARCHAR(20) NOT NULL,code_hash CHAR(64) NOT NULL,purpose VARCHAR(16) NOT NULL,expires_at DATETIME NOT NULL,used BOOLEAN DEFAULT FALSE,attempts INT DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS jobs(id INT AUTO_INCREMENT PRIMARY KEY,application_id CHAR(36) NOT NULL,kind VARCHAR(20) NOT NULL,status VARCHAR(20) DEFAULT 'PENDING',attempts INT DEFAULT 0,generation INT NOT NULL DEFAULT 1,next_at DATETIME DEFAULT CURRENT_TIMESTAMP,last_error VARCHAR(300),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,UNIQUE(application_id,kind));
CREATE TABLE IF NOT EXISTS audit_logs(id BIGINT AUTO_INCREMENT PRIMARY KEY,actor VARCHAR(80) NOT NULL,action VARCHAR(80) NOT NULL,target VARCHAR(80) NOT NULL,detail JSON NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`);
const [jobColumns]=await connection.query("SHOW COLUMNS FROM jobs LIKE 'generation'");
if(!jobColumns.length)await connection.query('ALTER TABLE jobs ADD COLUMN generation INT NOT NULL DEFAULT 1');
await connection.execute('INSERT IGNORE INTO event_settings VALUES(1,?)',[JSON.stringify({title:'榉之乡上海研修',date:'2026-11-25',venue:'上药信谊大厦2F',capacity:120,organizationCapacity:20,endsAt:'2026-11-25 23:59:59',registrationOpen:true,contact:'请通过原报名邀请渠道联系活动工作人员',privacyEntity:'待活动方确认',refundPolicy:'正式退款条款待财务确认。',legalConfirmed:false})]);
await connection.execute('INSERT IGNORE INTO admin_users(username,password_hash,role) VALUES(?,?,?)',[process.env.ADMIN_USER,await bcrypt.hash(process.env.ADMIN_PASSWORD,12),'admin']);
await connection.end();
console.log('项目专用 MySQL 数据库与管理账号初始化完成。');
