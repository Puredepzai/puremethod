// Hàm parse MP4 Boxes an toàn, chống treo/đóng băng trình duyệt
export function parseMP4Boxes(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 0;
  const boxes = [];
  
  // Giới hạn tối đa 10,000 vòng lặp để làm "phanh khẩn cấp" 
  // Nếu gặp file lỗi, vòng lặp tự thoát chứ không làm treo web
  let safetyCounter = 0; 
  const MAX_LOOPS = 10000;

  while (offset < arrayBuffer.byteLength) {
    safetyCounter++;
    if (safetyCounter > MAX_LOOPS) {
      console.warn("CẢNH BÁO: Phát hiện vòng lặp vô hạn khi parse MP4! Đã tự động ngắt để tránh treo web.");
      break;
    }

    if (offset + 8 > arrayBuffer.byteLength) break;

    const size = view.getUint32(offset);
    // Đọc 4 byte tên box (ví dụ: moov, ftyp, mdat)
    let type = "";
    for (let i = 0; i < 4; i++) {
      type += String.fromCharCode(view.getUint8(offset + 4 + i));
    }

    // Phòng trường hợp size bằng 0 (hợp lệ trong cấu trúc MP4 nhưng dễ gây lặp vô hạn nếu xử lý sai)
    if (size === 0) {
      boxes.push({ type, size: arrayBuffer.byteLength - offset, offset });
      break; 
    }

    // Phòng trường hợp size bị lỗi âm hoặc quá nhỏ không dịch chuyển được offset
    if (size < 8) {
      console.error(`Kích thước Box ${type} không hợp lệ (${size} bytes). Dừng parse.`);
      break;
    }

    boxes.push({ type, size, offset });
    offset += size;
  }

  return boxes;
}
