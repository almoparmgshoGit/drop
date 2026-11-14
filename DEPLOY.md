# رفع المشروع على السيرفر (من غير Docker)

الأوامر دي لـ **Ubuntu 22.04 أو 24.04**، وعلى سيرفر فاضي مش عليه مشاريع تانية.
نفذ الأقسام بالترتيب. لو أي أمر طلع خطأ، **وقف** وابعت الخطأ قبل ما تكمل.

مفيش أسرار في الملف ده. متكتبش فيه ولا تبعت في أي شات أي باسوورد أو محتوى `backend.env`.

## قبل ما تبدأ

- وجّه الدومينين (`A record`) على IP السيرفر، زي `api.example.com` و`admin.example.com`.
- لو شركة السيرفر عندها جدار حماية خاص بيها، افتح فيه 22 و80 و443 بس.

في **كل جلسة SSH جديدة**، عرّف القيم دي بقيمك الحقيقية:

```bash
export API_DOMAIN=api.example.com
export ADMIN_DOMAIN=admin.example.com
export CERT_EMAIL=you@example.com
export REPO=git@github.com:almoparmgshoGit/drop.git
```

## 1. مفتاح SSH ومستخدم `deploy`

**على جهازك (PowerShell).** استبدل `USER` بالمستخدم اللي معاك و`SERVER_IP` بالـ IP:

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh USER@SERVER_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
ssh USER@SERVER_IP
```

**على السيرفر:**

```bash
sudo adduser deploy        # هيطلب باسوورد: ده باسوورد sudo، خليه قوي واحفظه
sudo usermod -aG sudo deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo install -m 600 -o deploy -g deploy ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

**من نافذة جديدة، ومن غير ما تقفل القديمة:**

```powershell
ssh deploy@SERVER_IP
sudo whoami     # لازم يطبع root
```

كمل كل اللي جاي وأنت داخل بـ `deploy`.

## 2. تأمين السيرفر

⚠️ سيب نافذة SSH مفتوحة لحد ما تجرب الدخول من نافذة جديدة في آخر القسم، عشان لو حاجة غلطت متتقفلش برا السيرفر.

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh

sudo apt update && sudo apt -y upgrade
sudo apt install -y ufw fail2ban unattended-upgrades nginx postgresql certbot python3-certbot-nginx git curl tmux build-essential python3

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

لو SSH عندك على منفذ غير 22، افتحه في `ufw` قبل `ufw enable`.

**جرب من نافذة جديدة:** `ssh deploy@SERVER_IP` لازم يدخل. ولو جربت `ssh root@SERVER_IP` لازم يترفض.

## 3. تنزيل الكود من GitHub

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_durob -N "" -C "durob-server"
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_durob
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/github_durob.pub
```

انسخ السطر اللي طلع وضيفه في GitHub: **Repo ← Settings ← Deploy keys ← Add**، ومن غير ما تفعّل الكتابة. بعدها:

```bash
sudo install -d -o deploy -g deploy /opt/durob
git clone "$REPO" /opt/durob/app
sudo adduser --system --group --no-create-home durob
```

## 4. قاعدة البيانات والأسرار

نفذ القسم ده كله مرة واحدة في نفس الجلسة. الأسرار بتتولد على السيرفر ومش بتظهر على الشاشة.

```bash
DB_PASS=$(openssl rand -hex 32)
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE durob LOGIN PASSWORD '$DB_PASS';
CREATE DATABASE durob_db OWNER durob;
SQL

sudo install -d -m 750 -o root -g deploy /etc/durob
sudo install -m 640 -o root -g deploy /dev/null /etc/durob/backend.env
sudo tee /etc/durob/backend.env >/dev/null <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
DATABASE_URL=postgresql://durob:$DB_PASS@localhost:5432/durob_db?schema=public
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
TICKET_SIGNING_SECRET=$(openssl rand -hex 48)
SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 48)
JWT_ACCESS_EXPIRES_IN=15m
CORS_ORIGINS=https://$ADMIN_DOMAIN
TRUST_PROXY_HOPS=1
OTP_DEV_ECHO=false
PAYMENT_MODE=simulated
CLIENT_TRIAL_MODE=true
EOF
unset DB_PASS
sudo ss -ltnp | grep 5432      # لازم يظهر 127.0.0.1 بس
```

## 5. بناء الباك إند

```bash
cd /opt/durob/app
npm ci
npx prisma generate
npm run build
```

## 6. اختبارات e2e على قاعدة مؤقتة

الاختبارات بتفضي كل الجداول، وعشان كده ليها قاعدة منفصلة. ممكن تاخد وقت، فشغلها جوه `tmux`:

```bash
tmux new -s e2e
cd /opt/durob/app
TEST_PASS=$(openssl rand -hex 32)
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE durob_test LOGIN PASSWORD '$TEST_PASS';
CREATE DATABASE durob_test OWNER durob_test;
SQL
export DATABASE_URL="postgresql://durob_test:$TEST_PASS@localhost:5432/durob_test?schema=public"
npx prisma migrate deploy
npm run test:e2e 2>&1 | tee ~/e2e.log
tail -n 8 ~/e2e.log
```

**لو فيه اختبار فشل، وقف وابعت `~/e2e.log`** لأن فيه ترقيات مكتبات لسه ماتجربتش بالاختبارات دي. لو كله نجح، امسح القاعدة المؤقتة واقفل الجلسة:

```bash
unset DATABASE_URL TEST_PASS
sudo -u postgres psql -c "DROP DATABASE durob_test;" -c "DROP ROLE durob_test;"
exit
```

## 7. تجهيز القاعدة الحقيقية وحساب المدير

```bash
cd /opt/durob/app
( set -a; . /etc/durob/backend.env; set +a; npx prisma migrate deploy )

read -rp 'Admin phone (05xxxxxxxx): ' ADMIN_PHONE
read -rsp 'Admin password (12+ chars): ' ADMIN_PASSWORD; echo
( set -a; . /etc/durob/backend.env; set +a; ADMIN_PHONE="$ADMIN_PHONE" ADMIN_PASSWORD="$ADMIN_PASSWORD" npm run admin:set )
unset ADMIN_PHONE ADMIN_PASSWORD

npm prune --omit=dev
```

## 8. تشغيل الباك إند كخدمة

```bash
sudo tee /etc/systemd/system/durob-api.service >/dev/null <<'EOF'
[Unit]
Description=Durob Al Hijra API
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
User=durob
Group=durob
WorkingDirectory=/opt/durob/app
EnvironmentFile=/etc/durob/backend.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now durob-api
sudo systemctl status durob-api --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/v1/
```

أي رقم زي `401` أو `404` معناه إن الخدمة شغالة. لو طلع `000`، شوف السبب: `sudo journalctl -u durob-api -n 50 --no-pager`.

## 9. تشغيل لوحة الأدمن

اللوحة مش في ريبو الباك إند. الأوامر دي محتاجة كودها يكون موجود في `/opt/durob/durob-admin`، سواء من ريبو خاص بيها أو بنسخه للسيرفر. ولو هترفعها في مكان تاني، سيب القسم ده وجزء الأدمن في Nginx، وعدّل `CORS_ORIGINS` لدومينها.

```bash
cd /opt/durob/durob-admin
npm ci
NEXT_PUBLIC_API_URL="https://$API_DOMAIN/api/v1" npm run build

sudo tee /etc/systemd/system/durob-admin.service >/dev/null <<'EOF'
[Unit]
Description=Durob Al Hijra admin panel
After=network-online.target
Wants=network-online.target

[Service]
User=durob
Group=durob
WorkingDirectory=/opt/durob/durob-admin
Environment=NODE_ENV=production
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now durob-admin
sudo systemctl status durob-admin --no-pager
```

## 10. Nginx وHTTPS

الدومينين لازم يكونوا موجهين للسيرفر قبل الخطوة دي. حد الرفع 130MB لأن البلاغ ممكن يبقى فيه 5 ملفات، كل واحد لحد 25MB.

```bash
sudo tee /etc/nginx/conf.d/durob-common.conf >/dev/null <<'EOF'
server_tokens off;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF

sudo tee /etc/nginx/sites-available/durob >/dev/null <<'EOF'
server {
    listen 80;
    server_name API_DOMAIN_HERE;
    client_max_body_size 130m;

    location /api/v1/realtime {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}

server {
    listen 80;
    server_name ADMIN_DOMAIN_HERE;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo sed -i "s/API_DOMAIN_HERE/$API_DOMAIN/; s/ADMIN_DOMAIN_HERE/$ADMIN_DOMAIN/" /etc/nginx/sites-available/durob
sudo ln -sf /etc/nginx/sites-available/durob /etc/nginx/sites-enabled/durob
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d "$API_DOMAIN" -d "$ADMIN_DOMAIN" --redirect --hsts -m "$CERT_EMAIL" --agree-tos -n
```

**تأكد:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://$API_DOMAIN/api/v1/"
curl -s -o /dev/null -w '%{http_code}\n' "https://$ADMIN_DOMAIN/"
sudo ss -ltnp | grep -E ':(3000|4000|5432)\b'    # كلهم لازم يكونوا على 127.0.0.1
sudo ufw status
```

## 11. النسخ الاحتياطي

نسخة كل يوم 3:15 الفجر بتوقيت السيرفر، وبتتحفظ 14 يوم.

```bash
sudo install -d -m 2750 -o root -g deploy /var/backups/durob
sudo tee /usr/local/sbin/durob-backup >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
umask 027
dir=/var/backups/durob
file="$dir/durob_db-$(date +%F-%H%M).dump"
sudo -u postgres pg_dump -Fc durob_db > "$file.tmp"
mv "$file.tmp" "$file"
find "$dir" -name '*.dump' -mtime +14 -delete
EOF
sudo chmod 750 /usr/local/sbin/durob-backup
echo '15 3 * * * root /usr/local/sbin/durob-backup' | sudo tee /etc/cron.d/durob-backup >/dev/null
sudo /usr/local/sbin/durob-backup
ls -lh /var/backups/durob
```

**جرب الاسترجاع مرة** على قاعدة مؤقتة. لازم يطبع عدد جداول أكبر من صفر:

```bash
latest=$(ls -t /var/backups/durob/*.dump | head -n1)
sudo -u postgres createdb durob_restore_test
sudo cat "$latest" | sudo -u postgres pg_restore -d durob_restore_test
sudo -u postgres psql -d durob_restore_test -tc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
sudo -u postgres dropdb durob_restore_test
```

**انسخ النسخ لجهازك بانتظام (PowerShell).** ده مهم لأن النسخ على السيرفر بس هتضيع معاه لو وقع. الملفات فيها بيانات حساسة، فخليها في مكان آمن:

```powershell
New-Item -ItemType Directory -Force D:\Backups\durob
scp "deploy@SERVER_IP:/var/backups/durob/*.dump" D:\Backups\durob\
```

## 12. متابعة الأخطاء (Sentry)

اختياري. من غيره مفيش أي حاجة بتتبعت لبره، والسيرفر شغال زي ما هو. اعمل حساب على sentry.io ومشروعين: واحد **Node.js** للباك إند وواحد **Next.js** للوحة، وخد الـ DSN بتاع كل واحد.

**الباك إند:** ضيف السطور دي لملف الأسرار، وبعدين `sudo systemctl restart durob-api`:

```bash
sudo tee -a /etc/durob/backend.env >/dev/null <<'EOF'
SENTRY_DSN=حط_DSN_مشروع_الباك_إند_هنا
SENTRY_ENVIRONMENT=production
EOF
```

- أي خطأ 500 أو شغلانة خلفية فشلت بيوصل Sentry برقم الحساب والمسار بس. هيدر الدخول والكوكيز والتوكنات وأرقام الجوالات والهويات بتتشال قبل ما يخرج.
- أعطال تطبيق الجوال بتوصل برضه عن طريق السيرفر (`POST /api/v1/monitoring/client-errors`)، فالتطبيق مش محتاج DSN. يتفعل من التطبيق بـ `EXPO_PUBLIC_ERROR_REPORTING=true` في بناء جديد (OTA كفاية، مفيش مكتبة native جديدة).

**اللوحة:** الـ DSN بيتقري وقت البناء، فابني بيه:

```bash
cd /opt/durob/durob-admin
NEXT_PUBLIC_API_URL="https://$API_DOMAIN/api/v1" NEXT_PUBLIC_SENTRY_DSN="DSN_مشروع_اللوحة" npm run build
sudo systemctl restart durob-admin
```

لو عايز الأخطاء تبان بأسماء الملفات الحقيقية، زوّد وقت البناء `SENTRY_AUTH_TOKEN` و`SENTRY_ORG` و`SENTRY_PROJECT` (من Settings ← Auth Tokens في Sentry). من غيرهم البناء زي ما هو.

## 13. تنبيه لو السيرفر وقع

**فحص الصحة:** `https://$API_DOMAIN/api/v1/health` مفتوح من غير دخول. بيرد `200` و`"status":"ok"` طول ما قاعدة البيانات (وRedis لو متظبط) شغالين، و`503` لو حاجة منهم واقعة. مفيهوش أي بيانات، بس حالة كل جزء وآخر مرة الشغلانات الخلفية اشتغلت.

```bash
curl -s "https://$API_DOMAIN/api/v1/health"
```

**مراقب من بره (الأهم):** لأن السيرفر لو وقع مش هيقدر يبلغ عن نفسه. اعمل حساب مجاني على [UptimeRobot](https://uptimerobot.com) أو [Better Stack](https://betterstack.com/uptime):

1. New Monitor ← نوعه **HTTP(s)** (أو Keyword وكلمة `"ok"`).
2. الرابط: `https://API_DOMAIN/api/v1/health`، كل 1 لـ 5 دقايق.
3. ضيف إيميلك ورقمك (SMS أو واتساب أو تطبيقهم) في التنبيهات، ويفضل اتنين من الإدارة.
4. ضيف مراقب تاني للوحة على `https://ADMIN_DOMAIN/`.

**تنبيه من systemd لو الخدمة وقعت ومقدرتش تقوم:** الخدمة بتعيد التشغيل لوحدها (`Restart=on-failure`). لو فشلت أكتر من 5 مرات في 10 دقايق بتقف، والسطور دي بتشغّل سكربت تنبيه ساعتها. السكربت بيبعت لرابط Webhook (مثلًا Better Stack Heartbeat أو قناة Slack/Discord):

```bash
sudo tee /usr/local/sbin/durob-alert >/dev/null <<'EOF'
#!/bin/bash
# $1 = اسم الخدمة اللي وقعت
URL=$(cat /etc/durob/alert-webhook 2>/dev/null)
[ -n "$URL" ] && curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
  -d "{\"text\":\"Durob: $1 stopped on $(hostname) at $(date -Is)\"}" "$URL" >/dev/null
logger -t durob-alert "$1 failed"
EOF
sudo chmod 755 /usr/local/sbin/durob-alert
echo 'https://رابط_الـWebhook' | sudo tee /etc/durob/alert-webhook >/dev/null
sudo chmod 640 /etc/durob/alert-webhook

sudo tee /etc/systemd/system/durob-alert@.service >/dev/null <<'EOF'
[Unit]
Description=Alert that %i failed

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/durob-alert %i
EOF

sudo mkdir -p /etc/systemd/system/durob-api.service.d
sudo tee /etc/systemd/system/durob-api.service.d/alert.conf >/dev/null <<'EOF'
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=5
OnFailure=durob-alert@%n.service
EOF
sudo systemctl daemon-reload
```

جرّب التنبيه: `sudo systemctl start durob-alert@test.service`. ولو حابب تشوف الأخطاء الأخيرة من السجل: `sudo journalctl -u durob-api -p err --since "1 hour ago" --no-pager`.

**تنبيهات جوه النظام:** فيه شغلانة بتلف كل دقيقة على الرحلات، وبتبلغ المدير والمسؤولين عن الرحلات (إشعار في اللوحة وعلى الجوال) مرة واحدة لكل رحلة لو:

- المشرف مافتحش التطبيق قبل الانطلاق بالمدة اللي في الإعدادات (افتراضيًا 60 دقيقة)، وبتبعت للمشرف تذكير.
- موقع الباص انقطع أثناء الرحلة (لا من الجوال ولا من جهاز GPS) أكتر من المدة اللي في الإعدادات (افتراضيًا 15 دقيقة).

المدد دي بتتغير من الإعدادات ← الحجز والتشغيل. وآخر مرة الشغلانة دي اشتغلت بتظهر في `workers` في رد `/health`؛ لو وقفت أكتر من كام دقيقة يبقى فيه مشكلة.

## 14. جهاز GPS ثابت في الباص

اختياري. من غيره الموقع بييجي من جوال المشرف زي الأول. ولو الاتنين شغالين، الخريطة بتعتمد الجهاز، ولو الجهاز سكت (افتراضيًا 3 دقايق) بترجع لجوال المشرف لوحدها.

1. من اللوحة: الباصات ← زرار **جهاز GPS** جنب الباص ← اكتب رقم الجهاز (IMEI أو المعرّف) ← تسجيل ← **إصدار رمز الجهاز**. الرمز بيظهر **مرة واحدة بس**، انسخه على طول. لو ضاع اعمل رمز جديد، والقديم بيقف فورًا.
2. على الجهاز (أو تطبيق Traccar Client على جوال ثابت في الباص): بروتوكول **OsmAnd**، والعنوان:
   `https://API_DOMAIN/api/v1/gps/ingest?token=الرمز` ومعرّف الجهاز نفس الرقم اللي سجلته. الصفحة في اللوحة فيها الروابط جاهزة للنسخ.
3. الأجهزة اللي بتتكلم بروتوكولات خاصة (GT06 وغيرها) شغّلها على سيرفر Traccar، وفعّل فيه `forward.url` بالقالب الموجود في نفس الصفحة.

الموقع بيتقبل بس في ساعات تتبع رحلة الباص ده مسند ليها (نفس مواعيد بث الجوال). وصفحة التتبع بتوضح مصدر كل موقع (جهاز/جوال) وحالة الجهاز (متصل/غير متصل).

## 15. الاختبارات التلقائية على GitHub

الملف `.github/workflows/ci.yml` بيشغّل مع كل push وpull request: تثبيت المكتبات، الـ migrations على PostgreSQL مؤقت، فحص الأنواع، البناء، واختبارات e2e. مش محتاج أي secrets: القاعدة بتتعمل جوه GitHub وبتتمسح بعدها، والأسرار التجريبية موجودة في `test/setup-env.ts`. النتيجة بتظهر في تبويب **Actions** في الريبو. لو حابب تمنع الدمج لو فشلت: Settings ← Branches ← Branch protection ← Require status checks ← اختار `test`.

## تحديث السيرفر بعد أي تعديل

```bash
cd /opt/durob/app && git pull --ff-only

npm ci
npx prisma generate
npm run build
( set -a; . /etc/durob/backend.env; set +a; npx prisma migrate deploy )
npm prune --omit=dev
sudo systemctl restart durob-api

cd /opt/durob/durob-admin
npm ci
NEXT_PUBLIC_API_URL="https://$API_DOMAIN/api/v1" npm run build
sudo systemctl restart durob-admin
```

خد نسخة احتياطية (`sudo /usr/local/sbin/durob-backup`) قبل أي تحديث فيه migration جديد.

## لو حصلت مشكلة

```bash
sudo journalctl -u durob-api -n 100 --no-pager
sudo journalctl -u durob-admin -n 100 --no-pager
sudo tail -n 50 /var/log/nginx/error.log
```

## قبل الإطلاق الحقيقي

`CLIENT_TRIAL_MODE=true` مؤقت. طول ما هو شغال، الحجوزات بتتأكد من غير تحصيل فلوس، وأي مدير عام يقدر يدخل على حساب أي عميل. قبل دخول عملاء حقيقيين:

1. اربط بوابة الدفع وواتساب.
2. احذف `CLIENT_TRIAL_MODE` وخلي `PAYMENT_MODE=disabled` لحد ما البوابة تشتغل.
3. ابدأ بقاعدة بيانات نضيفة من غير بيانات التجربة.
4. احذف كود الوضع التجريبي من المشروع.
