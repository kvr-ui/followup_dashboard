require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const seedAdmin = require('./config/seed');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(seedAdmin)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
