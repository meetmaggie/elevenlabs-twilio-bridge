# Pin Node 20 so builds always use the right version
FROM node:20-alpine

WORKDIR /app

# Install dependencies (works even without package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
