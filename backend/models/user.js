const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(120) },
  email: { type: DataTypes.STRING(200), unique: true, allowNull: false, validate: { isEmail: true } },
  password: { type: DataTypes.STRING(255), allowNull: false, validate: { notEmpty: true } },
  phone: { type: DataTypes.STRING(20), allowNull: true },
}, {
  tableName: 'users',
  timestamps: false,
  hooks: {
    beforeValidate(user) {
      if (user.email) {
        user.email = user.email.toLowerCase().trim();
      }
      if (user.name) {
        user.name = user.name.trim();
      }
      if (user.password) {
        user.password = user.password.trim();
      }
      if (user.phone) {
        user.phone = user.phone.trim();
      }
    }
  }
});

User.prototype.verifyPassword = function(password) {
  return password === this.password;
};

module.exports = User;
