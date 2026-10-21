# Official Playwright image: Chromium and its system libraries preinstalled.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY book.mjs ./
ENV TZ=Asia/Kolkata
CMD ["npm", "start"]
