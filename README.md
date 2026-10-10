# Sandesh: private chat app (v3)

Real-time chat jo browser mein chalta hai. Robotics-style themes, Google (Gmail) login, push notifications,
photos, emoji, reply, delete (apne liye / sabke liye), contact nicknames, admin console.

**Stack:** Node.js, Express, Socket.IO, MongoDB Atlas, bcrypt + JWT, Web Push, Google Identity Services.

## Render Environment Variables

| Key | Zaruri? | Kya hai |
|---|---|---|
| `MONGO_URI` | Haan | Atlas connection string |
| `JWT_SECRET` | Haan | Lambi random string |
| `INVITE_CODE` | Haan | Naye signup (Gmail wale bhi) ke liye secret code |
| `ADMIN_USERNAME` | Admin ke liye | Jaise `anujadmin` (3-20 letters/numbers/_) |
| `ADMIN_PASSWORD` | Admin ke liye | Admin ka password (6+ characters). Badalna ho to yahi badlo |
| `GOOGLE_CLIENT_ID` | Gmail login ke liye | Google Cloud se milta hai (neeche steps) |

Push notification ki keys server khud bana leta hai, kuch set nahi karna.

## Google (Gmail) login setup
1. console.cloud.google.com par jao, ek naya project banao.
2. **APIs & Services > OAuth consent screen**: External chuno, app name `Sandesh`, apni email daalo, save karo.
   Phir **Audience / Test users** mein apni aur doston ki Gmail add karo (Publish karne tak sirf test users login kar sakte hain).
3. **Credentials > Create credentials > OAuth client ID** > Application type: **Web application**.
4. **Authorized JavaScript origins** mein apna Render link daalo, jaise `https://sandesh-xxxx.onrender.com` (aakhir mein `/` nahi).
5. Create dabao, **Client ID** copy karo, Render mein `GOOGLE_CLIENT_ID` naam se daalo. Save karne par app redeploy hogi.

## Admin
`ADMIN_USERNAME` aur `ADMIN_PASSWORD` set karo. Normal login screen se usi username/password se login karo.
Sidebar mein **ADMIN** button aayega: wahan se kisi ka password reset ya account delete kar sakte ho.

## Forgot password
- Gmail se signup kiya hai: **Continue with Google** dabao, password ki zaroorat nahi.
- Password wale account: admin **Reset password** se temporary password deta hai. Login ke baad Settings mein badlo.

## Notifications
Login ke baad sidebar mein **Enable** dabao aur browser ki permission do. App band hone par bhi message aane par alert aayega.
iPhone par pehle Share > **Add to Home Screen** karo aur wahin se app kholo.

## Update kaise karein
Files GitHub par upload/replace karo (`server.js`, `package.json`, `package-lock.json`, `public/` folder). Render apne aap redeploy karega.

## Security notes
- Passwords bcrypt se hash hote hain, login par rate limit hai, sab kuch HTTPS par.
- Ye **end-to-end encrypted nahi** hai. Messages database mein save hote hain.
- `.env` aur secrets GitHub par kabhi mat daalo.
