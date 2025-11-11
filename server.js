const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = 3000;

// ===== Session setup =====
app.use(session({
  secret: 'renthubSecretKey',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 hour
}));

// ===== Middleware =====
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== MySQL Connection =====
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Heshu@2005',
  database: 'renthubdb',
  port: 3300,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise(); // Added .promise()

// Initial database connection check
async function testDbConnection() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('✅ Connected to MySQL database via pool (promise-based)!');
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1); // Exit process if cannot connect to DB
  } finally {
    if (connection) connection.release(); // Release the connection
  }
}
testDbConnection();

// ===== Multer setup for image uploads =====
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// ===== Middleware to protect pages =====
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  // Check if the request is for an API endpoint
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Please log in.' });
  }
  res.redirect('/sign.html');
}

// ===== API Routes =====

// --------- REGISTER USER ---------
app.post('/api/register', async (req, res) => {
  const { fullname, email, password, phone } = req.body;
  const checkQuery = 'SELECT * FROM users WHERE email = ?';
  try {
    const [existingUsers] = await pool.query(checkQuery, [email]);
    if (existingUsers.length > 0) {
      return res.json({ success: false, message: 'Email already registered.' });
    }

    const insertQuery = `
      INSERT INTO users (fullname, email, password, phone)
      VALUES (?, ?, ?, ?)
    `;
    const [result2] = await pool.query(insertQuery, [fullname, email, password, phone || '']);
    res.json({
      success: true,
      message: 'Registration successful!',
      userId: result2.insertId
    });
  } catch (err) {
    console.error('Registration SQL Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// --------- LOGIN USER ---------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const query = 'SELECT * FROM users WHERE email = ? AND password = ?';
  try {
    const [rows] = await pool.query(query, [email, password]);

    if (rows.length === 0) {
      return res.json({ success: false, message: 'Invalid email or password' });
    }

    const user = rows[0];
    req.session.user = user;
    res.json({ success: true, message: 'Login successful!', user: user });

  } catch (err) {
    console.error("Login SQL Error:", err);
    res.status(500).json({ success: false, message: "Database error during login." });
  }
});

// --------- LOGOUT USER ---------
app.get('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).send('Error logging out');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ✅ Check session
app.get('/api/session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ===== API: Add rental with image upload =====
app.post('/api/rentals', isAuthenticated, upload.array('images', 5), async (req, res) => {
  const user = req.session.user;
  const {
    itemTitle, category, description, pricePerHour, pricePerDay,
    deposit, startDate, endDate, conditions, status
  } = req.body;

  const ownerName = user.fullname || '';
  const contact = user.phone || '';
  const email = user.email || '';
  const location = user.city || '';
  const images = req.files.map(f => `/uploads/${f.filename}`).join(',');

  const query = `
    INSERT INTO rentals
    (userId, ownerName, contact, email, location, itemTitle, category, description,
     pricePerHour, pricePerDay, deposit, startDate, endDate, conditions, status, images)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  try {
    const [result] = await pool.query(query, [
      user.id, ownerName, contact, email, location,
      itemTitle, category, description,
      pricePerHour || null, pricePerDay || null, deposit || null,
      startDate || null, endDate || null, conditions || '', status || 'Active', images
    ]);
    res.json({ success: true, message: 'Rental added successfully!', rentalId: result.insertId, images });
  } catch (err) {
    console.error('Add rental SQL Error:', err);
    res.status(500).json({ success: false, message: err.sqlMessage || err.message });
  }
});

// ===== API: Get user rental history =====
app.get('/api/rentals/history', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  try {
    const query = `
      SELECT
        r.*,
        b.price AS bookingPrice,
        b.durationType AS bookingDurationType,
        b.duration AS bookingDuration,
        r.pricePerDay,
        r.pricePerHour
      FROM rentals r
      LEFT JOIN bookings b ON r.id = b.listingId
      WHERE r.userId = ?
      ORDER BY r.id DESC, b.bookingDate DESC; /* Order by rental ID first to ensure all rentals are listed, then by bookingDate for relevant booking info */
    `;
    const [results] = await pool.query(query, [user.id]);
    console.log('DEBUG: Rentals history raw results:', results);
    const rentals = results.map(r => ({ ...r, images: r.images ? r.images.split(',') : [] }));
    res.json({ success: true, rentals });
  } catch (err) {
    console.error('History SQL Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get rentals booked by the user =====
app.get('/api/rentals/booked', isAuthenticated, async (req, res) => {
  const renterId = req.session.user.id;
  const query = `
    SELECT r.*, b.duration AS bookingDuration, b.price AS bookingPrice, b.durationType AS bookingDurationType
    FROM bookings b
    JOIN rentals r ON b.listingId = r.id
    WHERE b.renterId = ? AND (b.status = 'Confirmed' OR b.status = 'Completed')
    ORDER BY b.bookingDate DESC
  `;
  try {
    const [results] = await pool.query(query, [renterId]);
    const rentals = results.map(r => ({ ...r, images: r.images ? r.images.split(',') : [] }));
    res.json({ success: true, rentals });
  } catch (err) {
    console.error('Booked rentals SQL Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get all available rentals (most specific, placed before :id) =====
app.get('/api/rentals/available', isAuthenticated, async (req, res) => {
  console.log('DEBUG: /api/rentals/available route hit!');
  const userId = req.session.user.id;
  try {
    const [results] = await pool.query('SELECT * FROM rentals WHERE status="Active" AND userId != ? ORDER BY id DESC', [userId]);
    const rentals = results.map(r => ({
      ...r,
      images: r.images ? r.images.split(',') : [],
      ownerName: r.ownerName,
      contact: r.contact,
      email: r.email,
      location: r.location,
      userId: r.userId
    }));
    res.json(rentals);
  } catch (err) {
    console.error('Error fetching available rentals:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get single rental item by ID (more general, placed after /available) =====
app.get('/api/rentals/:id', isAuthenticated, async (req, res) => {
  const rentalId = req.params.id;
  try {
    const [results] = await pool.query('SELECT * FROM rentals WHERE id = ?', [rentalId]);
    if (results.length === 0) return res.status(404).json({ success: false, message: 'Rental not found' });

    const rental = { ...results[0], images: results[0].images ? results[0].images.split(',') : [] };
    res.json({ success: true, rental });
  } catch (err) {
    console.error('Single rental SQL Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get owner's notifications =====
app.get('/api/notifications', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [results] = await pool.query('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC', [userId]);
    res.json({ success: true, notifications: results });
  } catch (err) {
    console.error('Notifications SQL Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get unread notification count =====
app.get('/api/notifications/unread-count', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  // Notifications for the owner are pending booking requests
  const query = 'SELECT COUNT(*) AS unreadCount FROM notifications WHERE userId = ? AND isRead = 0 AND message LIKE \'%has requested to book%\'';
  try {
    const [rows] = await pool.query(query, [userId]);
    res.json({ success: true, unreadCount: rows[0].unreadCount });
  } catch (err) {
    console.error('Error fetching unread notification count:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Mark notification as read =====
app.put('/api/notifications/mark-read/:notificationId', isAuthenticated, async (req, res) => {
  const notificationId = req.params.notificationId;
  const userId = req.session.user.id;

  try {
    // Ensure the user owns the notification before marking as read
    const [notificationCheck] = await pool.query('SELECT userId FROM notifications WHERE id = ?', [notificationId]);

    if (notificationCheck.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    if (notificationCheck[0].userId !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized to mark this notification as read.' });
    }

    await pool.query('UPDATE notifications SET isRead = 1 WHERE id = ?', [notificationId]);
    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).json({ success: false, message: 'Failed to mark notification as read.' });
  }
});

// ===== API: Get unread message count =====
app.get('/api/messages/unread-count', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  // Messages are unread notifications that are NOT booking requests for owner, NOR booking confirmations for renter
  const query = 'SELECT COUNT(*) AS unreadCount FROM notifications WHERE userId = ? AND isRead = 0 AND message NOT LIKE \'%has requested to book%\' AND message NOT LIKE \'%has been confirmed by the owner!%\'';
  try {
    const [rows] = await pool.query(query, [userId]);
    res.json({ success: true, unreadCount: rows[0].unreadCount });
  } catch (err) {
    console.error('Error fetching unread message count:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== API: Get booking details by ID (for owner to view) =====
app.get('/api/booking-details/:bookingId', isAuthenticated, async (req, res) => {
  const bookingId = req.params.bookingId;
  const userId = req.session.user.id; // The owner requesting the details
  const query = `
    SELECT
      b.id AS bookingId,
      b.price AS bookingPrice,
      b.duration AS bookingDuration,
      b.durationType AS bookingDurationType,
      b.bookingDate,
      b.status AS status,
      rental_item.itemTitle,
      rental_item.description AS itemDescription,
      u.fullname AS renterName,
      u.email AS renterEmail,
      u.phone AS renterPhone
    FROM bookings b
    JOIN rentals rental_item ON b.listingId = rental_item.id
    JOIN users u ON b.renterId = u.id
    WHERE b.id = ? AND rental_item.userId = ?; /* Ensure only owner can view details */
  `;
  try {
    const [results] = await pool.query(query, [bookingId, userId]);
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found or not authorized.' });
    }
    res.json({ success: true, bookingDetails: results[0] });
  } catch (err) {
    console.error('Error fetching booking details:', err);
    res.status(500).json({ success: false, message: 'Database error while fetching booking details.' });
  }
});

// ===== API: Owner finalizes booking (accepts request) =====
app.put('/api/bookings/finalize/:bookingId', isAuthenticated, async (req, res) => {
  const bookingId = req.params.bookingId;
  const ownerId = req.session.user.id;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Get booking details to verify ownership and current status
    const [bookingResults] = await connection.query(
      'SELECT b.*, r.userId AS rentalOwnerId, r.itemTitle FROM bookings b JOIN rentals r ON b.listingId = r.id WHERE b.id = ?',
      [bookingId]
    );

    if (bookingResults.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }
    const booking = bookingResults[0];

    if (booking.rentalOwnerId !== ownerId) {
      await connection.rollback();
      return res.status(403).json({ success: false, message: 'Unauthorized: You do not own this rental.' });
    }

    if (booking.status !== 'Pending') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: `Booking status is already '${booking.status}'.` });
    }

    // 2. Update rental status to 'Rented' and set rentedBy
    await connection.query(
      'UPDATE rentals SET status = ?, rentedBy = ? WHERE id = ?',
      ['Rented', booking.renterId, booking.listingId]
    );

    // 3. Update booking status to 'Confirmed'
    await connection.query(
      'UPDATE bookings SET status = ? WHERE id = ?',
      ['Confirmed', bookingId]
    );

    // 4. Create notification for the renter (booking confirmed)
    const [renterNameResult] = await connection.query('SELECT fullname FROM users WHERE id = ?', [ownerId]);
    const ownerFullName = renterNameResult[0].fullname;

    const renterNotificationMessage = `Your booking for '${booking.itemTitle}' has been confirmed by the owner!`;
    await connection.query(
      'INSERT INTO notifications (userId, message, bookingId) VALUES (?, ?, ?)', 
      [booking.renterId, renterNotificationMessage, bookingId]
    );

    // 5. Delete the original pending notification for the owner
    await connection.query(
      'DELETE FROM notifications WHERE userId = ? AND bookingId = ? AND message LIKE \'%has requested to book%\'',
      [ownerId, bookingId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Booking confirmed and renter notified!' });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error finalizing booking:', err);
    res.status(500).json({ success: false, message: 'Failed to finalize booking due to a server error.' });
  } finally {
    if (connection) connection.release();
  }
});

// ===== API: Update user profile =====
app.put('/api/users/profile', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const { fullname, phone, city } = req.body;
  const query = 'UPDATE users SET fullname = ?, phone = ?, city = ? WHERE id = ?';
  try {
    await pool.query(query, [fullname, phone, city, userId]);
    req.session.user = { ...req.session.user, fullname, phone, city };
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ success: false, message: 'Database error while updating profile.' });
  }
});

// ===== API: Check user listing (for 'Give on Rent' button logic in profile.html) =====
app.get('/api/check-user-listing', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [listings] = await pool.query('SELECT COUNT(*) AS count FROM rentals WHERE userId = ?', [userId]);
    res.json({ success: true, hasListing: listings[0].count > 0 });
  } catch (err) {
    console.error('Error checking user listings:', err);
    res.status(500).json({ success: false, message: 'Database error checking listings.' });
  }
});

// ===== API: Book rental =====
app.post('/api/bookings', isAuthenticated, async (req, res) => {
  const { listingId, duration, durationType } = req.body;
  const renterId = req.session.user.id;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rentalResults] = await connection.query('SELECT * FROM rentals WHERE id=? AND status="Active"', [listingId]);
    if (rentalResults.length === 0) {
      await connection.rollback();
      return res.json({ success: false, message: 'Item not available' });
    }
    const rental = rentalResults[0];

    const price = rental.pricePerDay || rental.pricePerHour || 0;
    const durationValue = duration || 1; 
    const durationTypeValue = durationType || 'Per Hour'; 

    const insertBooking = `
      INSERT INTO bookings (listingId, renterId, ownerId, price, duration, durationType, bookingDate, status)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), 'Pending')
    `;
    const [result2] = await connection.query(insertBooking, [listingId, renterId, rental.userId, price, durationValue, durationTypeValue]);

    // Fetch renter's fullname for notification message
    const [renterInfo] = await connection.query('SELECT fullname FROM users WHERE id = ?', [renterId]);
    const renterFullName = renterInfo[0].fullname;

    // Create a notification for the owner
    const ownerNotificationMessage = `Renter ${renterFullName} has requested to book your item '${rental.itemTitle}' for ${durationValue} ${durationTypeValue}.`;
    await connection.query(
      'INSERT INTO notifications (userId, message, renterId, bookingId) VALUES (?, ?, ?, ?)',
      [rental.userId, ownerNotificationMessage, renterId, result2.insertId]
    );

    await connection.query('UPDATE rentals SET status="Pending", rentedBy=? WHERE id=?', [renterId, listingId]);
    
    await connection.commit();
    res.json({ success: true, message: 'Booking request sent to owner for confirmation!', bookingId: result2.insertId });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Booking SQL Error:', err);
    res.status(500).json({ success: false, message: 'Failed to create booking request due to a server error.' });
  } finally {
    if (connection) connection.release();
  }
});

// ===== API: Mark rental as returned =====
app.put('/api/rentals/return/:rentalId', isAuthenticated, async (req, res) => {
  const rentalId = req.params.rentalId;
  const userId = req.session.user.id; // User who is returning the item

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Verify the rental exists and is associated with the current user
    const [rentalCheck] = await connection.query('SELECT * FROM rentals WHERE id = ? AND rentedBy = ?', [rentalId, userId]);
    if (rentalCheck.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Rental not found or not rented by you.' });
    }

    // 2. Update the rental status to 'Returned'
    await connection.query('UPDATE rentals SET status = ? WHERE id = ?', ['Returned', rentalId]);

    // 3. Update the associated booking status to 'Completed'
    await connection.query('UPDATE bookings SET status = ? WHERE listingId = ? AND renterId = ? AND (status = \'Rented\' OR status = \'Confirmed\')', ['Completed', rentalId, userId]);

    // 4. Create a notification for the owner (optional, but good practice)
    const rental = rentalCheck[0];
    const ownerNotificationMessage = `Your item '${rental.itemTitle}' has been returned by ${req.session.user.fullname}.`;
    await connection.query(
      'INSERT INTO notifications (userId, message, bookingId) VALUES (?, ?, ?)', 
      [rental.userId, ownerNotificationMessage, rentalId] // rental.userId is the owner's ID
    );

    await connection.commit();
    res.json({ success: true, message: 'Item marked as returned successfully!' });

  } catch (err) {
    await connection.rollback();
    console.error('Error marking rental as returned:', err);
    res.status(500).json({ success: false, message: 'Database error while marking item as returned.' });
  } finally {
    if (connection) connection.release();
  }
});

// ===== Protected HTML pages =====
// 🔹 CHANGED: all now go through isAuthenticated to enforce login properly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/take-rent.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'takerent.html'))
);

app.get('/takerent/dashboard.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'takerent', 'dashboard.html'))
);

app.get('/dboard.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dboard.html'))
);

app.get('/addnewrental.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'addnewrental.html'))
);

app.get('/rent.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'rent.html'))
);

app.get('/dashboard.html', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

// ===== Static files middleware (moved to be AFTER all API and HTML page routes) =====
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));