CREATE DATABASE coffee_ordering;

USE coffee_ordering;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'server') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email (email)
);

CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_name (name)
);

CREATE TABLE menu_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category_id INT,
  image_url VARCHAR(255),
  availability BOOLEAN DEFAULT TRUE,
  dietary_tags JSON DEFAULT NULL, -- e.g., ["vegan", "gluten-free"]
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_category_id (category_id),
  INDEX idx_availability (availability)
);

CREATE TABLE promotions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  discount_percentage DECIMAL(5, 2) DEFAULT 0.00,
  item_id INT NULL, -- NULL for store-wide, non-NULL for item-specific
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES menu_items(id) ON DELETE SET NULL,
  INDEX idx_active (active),
  INDEX idx_dates (start_date, end_date)
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL, -- NULL for guest orders
  total_price DECIMAL(10, 2) NOT NULL,
  status ENUM('received', 'preparing', 'ready', 'delivered') DEFAULT 'received',
  order_type ENUM('local', 'delivery') NOT NULL,
  delivery_address TEXT,
  promotion_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_order_type (order_type)
);

CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT,
  item_id INT,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

-- Insert default admin (password: 'admin123' hashed with bcrypt)
INSERT INTO users (email, password_hash, role)
VALUES ('admin@coffeeapp.com', '$2b$10$8XJ9Zx3XJ9Zx3XJ9Zx3XJ9Zx3XJ9Zx3XJ9Zx3XJ9Zx3XJ9Zx3', 'admin');

-- Insert sample categories
INSERT INTO categories (name) VALUES ('Coffee'), ('Food'), ('Desserts');