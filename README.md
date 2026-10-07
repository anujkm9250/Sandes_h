# Sandesh: private chat app

Real-time chat jo browser mein chalta hai. Login + invite code, user search, typing indicator,
delivered/read ticks (✓ ✓✓), online / last seen, offline messages. Phone par "Add to Home Screen" se app jaisa.

**Stack:** Node.js, Express, Socket.IO, MongoDB (Atlas), bcrypt + JWT.

---

## Step 1: MongoDB Atlas (free database)
1. mongodb.com/atlas par signup karo, **M0 Free** cluster banao.
2. **Database Access** mein user banao (username + password, password yaad rakho).
3. **Network Access** mein `0.0.0.0/0` allow karo (Render ka IP badalta rehta hai).
4. **Connect > Drivers** se connection string copy karo. Usme `<password>` ki jagah apna password daalo
   aur `.net/` ke baad database naam likho, jaise `.../sandesh?retryWrites=true&w=majority`.

## Step 2: Laptop par test (optional)
1. Node.js 18+ install karo.
2. `.env.example` ko copy karke `.env` naam do aur teeno values bharo.
3. Terminal mein:
   ```
   npm install
   npm start
   ```
4. Browser mein `http://localhost:3000` kholo. Do alag browser (ya ek incognito) mein do account banao aur chat test karo.

## Step 3: GitHub par code daalo
1. github.com par repository banao (jaise `sandesh`). **Private** rakh sakte ho.
2. Repo mein **Add file > Upload files** se project ki files upload karo.
   **Mat upload karna:** `node_modules` folder aur `.env` file.
3. **Commit changes** dabao.

## Step 4: Render par deploy
1. render.com par GitHub se signup karo.
2. **New > Web Service**, apna repo chuno.
3. Settings:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
4. **Environment Variables** add karo:
   - `MONGO_URI`: Atlas wali connection string
   - `JWT_SECRET`: lambi random string (40+ characters)
   - `INVITE_CODE`: tumhara secret code, sirf doston ko batana
5. **Create Web Service**. 2-3 minute baad link milega, jaise `https://sandesh-xxxx.onrender.com`.

## Step 5: Dosto ko do
Link + invite code bhejo. Wo link kholega, **Sign up** karega (invite code ke saath), aur tum uska username search karke chat shuru kar sakte ho.

## Free plan ki baatein
- Idle hone par Render app so jata hai, pehla load 30-60 second le sakta hai.
  Isse bachne ke liye uptimerobot.com par `https://TUMHARA-LINK/health` ko har 5 minute mein ping karwao.
- Free plan ki shartein badalti rehti hain. Deploy se pehle Render aur Atlas ka pricing page dekh lo.

## Security notes
- Passwords bcrypt se hash hote hain; login/signup par rate limit hai; sab kuch HTTPS par chalta hai.
- Signup sirf invite code se hota hai. Code leak ho jaye to Render mein `INVITE_CODE` badal do.
- Ye **end-to-end encrypted nahi** hai. Messages database mein plain text mein save hote hain, to OTP ya bank details mat bhejna.
- `.env` aur secrets GitHub par kabhi mat daalo.

## Update kaise karein
Code badlo, GitHub par commit karo. Render apne aap dobara deploy kar dega.
